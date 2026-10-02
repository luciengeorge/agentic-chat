/**
 * Graph-style subscriptions: the validation handshake, then change notifications delivered in
 * order per subscription, retried with backoff, and logged.
 */
import { randomUUID } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { createLogger } from "@/lib/logger";

import { type Clock, iso } from "./clock";
import { awareDatetime } from "./corpus";
import { GraphError, badRequest, notFound } from "./errors";
import { NAMESPACE } from "./site";

const logger = createLogger("fake-workspace.delivery");

/** Graph's limit for driveItem subscriptions. */
const MAX_LIFETIME_MS = 42_300 * 60_000;

export interface DeliveryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayS: number;
  readonly maxDelayS: number;
  /** Graph waits 3s for the first attempt, then 10s for retries. */
  readonly timeoutS: number;
  readonly retryTimeoutS: number;
  readonly validationTimeoutS: number;
}

export const DEFAULT_POLICY: DeliveryPolicy = {
  maxAttempts: 8,
  baseDelayS: 1,
  maxDelayS: 60,
  timeoutS: 3,
  retryTimeoutS: 10,
  validationTimeoutS: 10,
};

export const SubscriptionRequestSchema = z.object({
  changeType: z.string(),
  notificationUrl: z.string(),
  resource: z.string(),
  expirationDateTime: awareDatetime,
  clientState: z.string().max(128),
});

export const SubscriptionRenewalSchema = z.object({ expirationDateTime: awareDatetime });

export type SubscriptionRequest = z.infer<typeof SubscriptionRequestSchema>;

export interface Subscription {
  readonly id: string;
  readonly site: string;
  readonly resource: string;
  readonly notificationUrl: string;
  readonly clientState: string;
  expiration: Date;
}

export function subscriptionJson(subscription: Subscription) {
  return {
    id: subscription.id,
    changeType: "updated",
    notificationUrl: subscription.notificationUrl,
    resource: subscription.resource,
    expirationDateTime: iso(subscription.expiration),
    clientState: subscription.clientState,
  };
}

interface Attempt {
  readonly at: Date;
  readonly status: number | null;
  readonly error: string | null;
}

export interface Delivery {
  readonly id: number;
  readonly subscriptionId: string;
  readonly changeSeq: number;
  state: "pending" | "delivered" | "failed" | "dropped";
  readonly attempts: Attempt[];
}

export function deliveryJson(delivery: Delivery) {
  return {
    id: delivery.id,
    subscription_id: delivery.subscriptionId,
    change_seq: delivery.changeSeq,
    state: delivery.state,
    attempts: delivery.attempts.map((a) => ({ at: iso(a.at), status: a.status, error: a.error })),
  };
}

export function tenantId(site: string): string {
  return uuidv5(`${site}:tenant`, NAMESPACE);
}

function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.name}: ${error.message}${cause}`;
}

export class Notifier {
  readonly subscriptions = new Map<string, Subscription>();
  deliveries: Delivery[] = [];
  /** Bumped by every reset. */
  generation = 0;
  /** Never reset, so a subscription id is never handed out twice... */
  private requests = 0;
  /** ...and a new process doesn't hand out its predecessor's. */
  private readonly nonce = randomUUID().replaceAll("-", "");
  private readonly tails = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<void>>();
  /** Aborted by a reset, which cancels every delivery in flight. */
  private cancel = new AbortController();

  constructor(
    private readonly clock: Clock,
    private readonly policy: DeliveryPolicy,
  ) {}

  async subscribe(site: string, request: SubscriptionRequest): Promise<Subscription> {
    if (request.changeType !== "updated") throw badRequest("A drive supports only the 'updated' change type.");
    const resource = request.resource.replace(/^\//, "");
    if (resource !== `sites/${site}/drive/root`) {
      if (resource.startsWith("sites/") && resource.endsWith("/drive/root")) {
        throw new GraphError(403, "accessDenied", "The token can't open that site.");
      }
      throw badRequest("Subscriptions are only supported on sites/{site}/drive/root.");
    }
    const url = URL.parse(request.notificationUrl);
    if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
      throw badRequest("The notificationUrl must be an http or https URL.");
    }
    this.checkExpiration(request.expirationDateTime);
    // Other requests move the counter on while this one validates.
    const n = ++this.requests;
    const requestId = uuidv5(`${site}:validation:${this.nonce}:${n}`, NAMESPACE);
    const generation = this.generation;
    await this.validate(
      request.notificationUrl,
      `Validation: Testing client application reachability for subscription Request-Id: ${requestId}`,
    );
    if (this.generation !== generation) {
      const message = "fake-workspace was reset while the subscription was being validated.";
      throw new GraphError(503, "serviceNotAvailable", message);
    }
    const subscription: Subscription = {
      id: uuidv5(`${site}:subscription:${this.nonce}:${n}`, NAMESPACE),
      site,
      resource: request.resource,
      notificationUrl: request.notificationUrl,
      clientState: request.clientState,
      expiration: request.expirationDateTime,
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  renew(site: string, subscriptionId: string, expiration: Date): Subscription {
    const subscription = this.live(site, subscriptionId);
    this.checkExpiration(expiration);
    subscription.expiration = expiration;
    return subscription;
  }

  remove(site: string, subscriptionId: string): void {
    this.subscriptions.delete(this.live(site, subscriptionId).id);
  }

  /** A change landed in `site`: queue a notification for each of its live subscriptions. */
  changed(site: string, seq: number): void {
    const { signal } = this.cancel;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.site !== site || !this.active(subscription)) continue;
      const delivery: Delivery = {
        id: this.deliveries.length + 1,
        subscriptionId: subscription.id,
        changeSeq: seq,
        state: "pending",
        attempts: [],
      };
      this.deliveries.push(delivery);
      const task = this.deliver(subscription, delivery, this.tails.get(subscription.id), signal).catch((error) => {
        if (!signal.aborted) logger.error("delivery crashed", { deliveryId: delivery.id, error });
      });
      this.tails.set(subscription.id, task);
      this.tasks.add(task);
      void task.then(() => {
        this.tasks.delete(task);
        if (this.tails.get(subscription.id) === task) this.tails.delete(subscription.id);
      });
    }
  }

  async flush(): Promise<void> {
    while (this.tasks.size) await Promise.all(this.tasks);
  }

  /**
   * Forget every subscription and delivery, and cancel the deliveries in flight. The state is
   * cleared before the first await: a change landing while the cancelled tasks wind down finds
   * nobody to notify, and a subscription still validating sees the new generation.
   */
  async reset(): Promise<void> {
    this.generation += 1;
    this.subscriptions.clear();
    this.deliveries = [];
    this.tails.clear();
    this.cancel.abort();
    this.cancel = new AbortController();
    await Promise.all(this.tasks);
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private checkExpiration(expiration: Date): void {
    const now = this.clock.now().getTime();
    if (expiration.getTime() <= now) throw badRequest("Subscription expiration must be in the future.");
    if (expiration.getTime() > now + MAX_LIFETIME_MS) {
      throw badRequest("Subscription expiration can only be 42300 minutes in the future.");
    }
  }

  private active(subscription: Subscription): boolean {
    const current = this.subscriptions.get(subscription.id) === subscription;
    return current && this.clock.now() < subscription.expiration;
  }

  private live(site: string, subscriptionId: string): Subscription {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || subscription.site !== site || !this.active(subscription)) {
      throw notFound("No such subscription.");
    }
    return subscription;
  }

  private async validate(url: string, token: string): Promise<void> {
    const failed = "Subscription validation request failed.";
    const target = new URL(url);
    target.searchParams.append("validationToken", token);
    let status: number;
    let contentType: string;
    let text: string;
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        signal: AbortSignal.timeout(this.policy.validationTimeoutS * 1000),
      });
      status = response.status;
      contentType = response.headers.get("content-type") ?? "";
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new GraphError(400, "InvalidRequest", "Subscription validation request timed out.");
      }
      throw new GraphError(400, "InvalidRequest", `${failed} ${explain(error)}`);
    }
    if (status !== 200) {
      const message = `${failed} Notification endpoint must respond with 200 OK to validation request.`;
      throw new GraphError(400, "InvalidRequest", message);
    }
    if (!contentType.startsWith("text/plain")) {
      throw new GraphError(400, "InvalidRequest", `${failed} The response must be text/plain.`);
    }
    if (text !== token) {
      const message = `${failed} Response must exactly match validationToken query parameter.`;
      throw new GraphError(400, "InvalidRequest", message);
    }
  }

  private async deliver(
    subscription: Subscription,
    delivery: Delivery,
    previous: Promise<void> | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await previous;
    const { maxAttempts, baseDelayS, maxDelayS } = this.policy;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) return;
      if (!this.active(subscription)) {
        delivery.state = "dropped";
        return;
      }
      const { status, error } = await this.post(subscription, attempt, signal);
      if (signal.aborted) return;
      delivery.attempts.push({ at: this.clock.now(), status, error });
      logger.info("notification delivery", {
        subscriptionId: subscription.id,
        deliveryId: delivery.id,
        attempt,
        status,
        error,
      });
      if (status !== null && status >= 200 && status < 300) {
        delivery.state = "delivered";
        return;
      }
      if (attempt < maxAttempts) {
        await this.clock.sleep(Math.min(baseDelayS * 2 ** (attempt - 1), maxDelayS), signal);
      }
    }
    delivery.state = "failed";
  }

  private async post(
    subscription: Subscription,
    attempt: number,
    signal: AbortSignal,
  ): Promise<{ status: number | null; error: string | null }> {
    const notification = {
      subscriptionId: subscription.id,
      clientState: subscription.clientState,
      changeType: "updated",
      resource: subscription.resource,
      subscriptionExpirationDateTime: iso(subscription.expiration),
      tenantId: tenantId(subscription.site),
    };
    const timeout = attempt === 1 ? this.policy.timeoutS : this.policy.retryTimeoutS;
    try {
      const response = await fetch(subscription.notificationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: [notification] }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)]),
      });
      await response.arrayBuffer();
      return { status: response.status, error: null };
    } catch (error) {
      // Any failure is a failed attempt, retried like a non-2xx answer.
      return { status: null, error: explain(error) };
    }
  }
}
