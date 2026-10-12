// Conformance harness (CONFORMANCE §2, app target): `tb-conformance app --start conformance.start.ts` boots the app with
// the env the suite gives it (fake bridge, enrolment code, TB_KEK, data dir) and drives it like the bridge does. The SDK
// listens on manifest `runtime.port` (SDK-API §13); `backupNow` lets the suite run the backup/restore round-trip (A7).
// `--test-roots` (C63): the suite passes TEST Portal Root Keys in TBCONF_PORTAL_ROOT_KEYS; only this harness reads it and
// hands them to startApp, so the key-set checks (A13) run against test roots. Production never reads that variable.
// TB_DATA_EPHEMERAL=1 (C80): the suite's data dir is a temp folder, not a mount point; only tests may say so.
import { startApp } from "@opt2-tealbrick/miniapp-sdk";
import { app, detectorRefresh, manifest } from "./src/app.ts";

export default async function start(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void>; backupNow(): Promise<void> }> {
  const harness = env.TBCONF_PORTAL_ROOT_KEYS ? ({ portalRootKeys: JSON.parse(env.TBCONF_PORTAL_ROOT_KEYS) } as Parameters<typeof startApp>[2]) : undefined;
  const running = await startApp(app, { TB_DATA_EPHEMERAL: "1", ...env }, harness);
  return {
    url: `http://127.0.0.1:${manifest.runtime.port}`,
    stop: () => {
      detectorRefresh.stop();
      return running.stop();
    },
    backupNow: async () => {
      await running.backups.runNow();
    },
  };
}
