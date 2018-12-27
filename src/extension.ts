import {
    ExtensionContext,
} from "vscode";
import { GlobalContext } from "./globalContext";

export async function activate(context: ExtensionContext) {
  const ctx = new GlobalContext();
  await ctx.activate();
  context.subscriptions.push(ctx);
}
