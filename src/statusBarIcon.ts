import { StatusBarAlignment, StatusBarItem, window } from "vscode";
import { Disposable } from "vscode-jsonrpc";
import { LanguageClient } from "vscode-languageclient";
import { dedent } from "./utils";

interface CclsInfoResponse {
  db: {
    files: number;
    funcs: number;
    types: number;
    vars: number;
  };
  pipeline: {
    pendingIndexRequests: number;
  };
  project: {
    entries: number;
  };
}

export class StatusBarIconProvider implements Disposable {
  private icon: StatusBarItem;
  private timer: NodeJS.Timer;

  public constructor(private client: LanguageClient, private updateInterval: number) {
    this.icon = window.createStatusBarItem(StatusBarAlignment.Right);
    this.icon.text = "ccls: loading";
    this.icon.tooltip = "ccls is starting / loading project metadata";
    this.icon.show();

    this.timer = setInterval(this.updateStatus.bind(this), updateInterval);
  }

  public dispose() {
    clearInterval(this.timer);
    this.icon.dispose();
  }

  private async updateStatus() {
    let info: CclsInfoResponse;
    try {
      info = await this.client.sendRequest<CclsInfoResponse>("$ccls/info");
    } catch (e) {
      this.icon.text = "ccls: error";
      this.icon.color = "red";
      this.icon.tooltip = "Failed to perform info request: " + (e as Error).message;
      return;
    }
    this.icon.color = "";
    this.icon.text = `ccls: ${info.pipeline.pendingIndexRequests || 0} jobs`;
    this.icon.tooltip = dedent`${info.db.files} files,
      ${info.db.funcs} functions,
      ${info.db.types} types,
      ${info.db.vars} variables,
      ${info.project.entries} entries in project.

      ${info.pipeline.pendingIndexRequests} pending index requests`;
  }
}
