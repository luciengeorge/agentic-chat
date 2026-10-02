import { main, REPO_ROOT } from "./ex/cli";
import { defaultSlotSwitch } from "./ex/switch";

process.exitCode = await main(process.argv.slice(2), {
  root: REPO_ROOT,
  io: { out: (text) => console.log(text), err: (text) => console.error(text) },
  slotSwitch: defaultSlotSwitch,
});
