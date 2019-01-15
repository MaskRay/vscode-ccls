import { commands, Disposable, ExtensionContext, } from "vscode";
import { ServerContext } from "./serverContext";
import { disposeAll } from "./utils";

export let ctx: GlobalContext;

/** object instance */
export class GlobalContext implements Disposable {
  private _dispose: Disposable[] = [];
  private _server: ServerContext;
  public constructor(
  ) {
    this._server = new ServerContext();
    this._dispose.push(commands.registerCommand("ccls.reload", () => {
      this._server.client.sendNotification("$ccls/reload");
    }));
    this._dispose.push(commands.registerCommand("ccls.restart", async () => this.restartCmd()));
    this._dispose.push(commands.registerCommand("ccls.restartLazy", async () => this.restartCmd(true)));
  }

  public dispose() {
    disposeAll(this._dispose);
    this._server.dispose();
  }

  public async activate() {
    await this._server.start();
  }

  private async restartCmd(lazy: boolean = false) {
    await this._server.client.stop();
    this._server.dispose();
    this._server = new ServerContext(lazy);
    return this._server.start();
  }
}
