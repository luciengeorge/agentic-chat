import type { Trigger } from "#learn/automations/automation";

import type { NewAutomationBody } from "./automation-form";

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  trigger: Trigger;
  enabled: boolean;
  lastFiredAt: string | null;
  lastRun: { id: string; status: string; createdAt: string } | null;
  createdAt: string;
}

async function call<T>(url: string, init?: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    const messages: Record<string, string> = {
      not_found: "That automation isn't yours, or it no longer exists.",
      disabled: "Turn the automation on first.",
      invalid_request: "Some fields aren't valid.",
    };
    throw new Error(messages[body.error ?? ""] ?? `Something went wrong (HTTP ${response.status}). Try again.`);
  }
  return (await response.json()) as T;
}

export const listAutomations = async () => (await call<{ automations: Automation[] }>("/api/automations")).automations;
export const createAutomation = (body: NewAutomationBody) =>
  call<{ id: string }>("/api/automations", { method: "POST", body });
export const setEnabled = (id: string, enabled: boolean) =>
  call(`/api/automations/${id}`, { method: "PATCH", body: { enabled } });
export const runNow = (id: string) => call(`/api/automations/${id}/run`, { method: "POST" });
