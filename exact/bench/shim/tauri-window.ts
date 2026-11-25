export function getCurrentWindow(): { startDragging(): Promise<void>; toggleMaximize(): Promise<void> } {
  return { startDragging: async () => undefined, toggleMaximize: async () => undefined };
}
