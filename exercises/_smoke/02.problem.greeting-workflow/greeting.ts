// 👨‍💼 Kestrel's agents will run as workflows, so the course has to grade code that runs inside a step.

export function formatGreeting(name: string): string {
  // 🐨 Return "hello " followed by the name.
  // 💰 A template literal does it: `hello ${name}`
  // 🦉 The test runs the workflow in src/workflows/greeting.ts, whose step imports
  //    `#learn/_sample/greeting`. While this step is active, that import loads your copy in playground/.
  // 📜 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals
  // 🚨 The test starts the workflow with "smoke" and checks that the run returns "hello smoke".
  throw new Error(`formatGreeting("${name}") isn't written yet`);
}
