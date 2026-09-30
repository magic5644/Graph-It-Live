export async function dispatch(): Promise<void> {
  const { run, getHelp: help } = await import("./commands.js");
  help();
  await run();
}

export function lazy(): Promise<string> {
  return import("./commands.js").then(({ loadLater }) => loadLater());
}
