import { formatGreeting } from "#learn/_sample/greeting";

// The smallest workflow with a slotted module inside a step. The hidden `_smoke` section grades it, to prove that
// `ex test` runs the learner's code inside workflow steps.
export async function greetingWorkflow(name: string) {
  "use workflow";

  return await greet(name);
}

async function greet(name: string) {
  "use step";

  return formatGreeting(name);
}
// The step's problem code throws on purpose, so fail on the first throw instead of retrying it.
greet.maxRetries = 0;
