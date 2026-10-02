// Workflow bundles workflow and step files with its own esbuild, outside Vite, and 5.0.1 has no option to add
// plugins there. patches/@workflow__builders@5.0.1.patch puts the plugins set here first in those builds.
export function setWorkflowEsbuildPlugins(plugins: readonly object[]) {
  (globalThis as Record<symbol, unknown>)[Symbol.for("workflow.esbuildPlugins")] = plugins;
}
