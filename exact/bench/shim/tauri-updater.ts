export type Update = { version: string; downloadAndInstall(): Promise<void> };
export async function check(): Promise<Update | null> {
  return null;
}
