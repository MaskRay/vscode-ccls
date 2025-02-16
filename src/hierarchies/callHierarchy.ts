import { commands, Position, TreeItem, Uri } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { Icon, IHierarchyNode } from '../types';
import { resourcePath } from '../utils';
import { Hierarchy } from './hierarchy';

enum CallType {
  Normal = 0,
  Base = 1,
  Derived = 2,
  All = CallType.Base | CallType.Derived // Normal and Base and Derived
}

interface CallHierarchyNode extends IHierarchyNode {
  children: CallHierarchyNode[];
  callType: CallType;
}

export class CallHierarchyProvider extends Hierarchy<CallHierarchyNode> {
  protected contextValue: string = 'extension.ccls.callHierarchyVisible';
  private baseIcon: Icon;
  private derivedIcon: Icon;
  private useCallee = false;
  private qualified = false;

  constructor(languageClient: LanguageClient, qualified: boolean) {
    super(languageClient, 'ccls.callHierarchy', 'ccls.closeCallHierarchy');
    this.baseIcon = {
      dark: resourcePath("base-dark.svg"),
      light: resourcePath("base-light.svg")
    };
    this.derivedIcon = {
      dark: resourcePath("derived-dark.svg"),
      light: resourcePath("derived-light.svg")
    };
    this.qualified = qualified;
    this._dispose.push(commands.registerCommand("ccls.call.useCallers", () => this.updateCallee(false)));
    this._dispose.push(commands.registerCommand("ccls.call.useCallees", () => this.updateCallee(true)));
  }

  public onTreeItem(ti: TreeItem, element: CallHierarchyNode) {
    if (element.callType === CallType.Base)
      ti.iconPath = this.baseIcon;
    else if (element.callType === CallType.Derived)
      ti.iconPath = this.derivedIcon;
  }

  protected async onGetChildren(element: CallHierarchyNode): Promise<CallHierarchyNode[]> {
    const result =
        await this.languageClient.sendRequest<CallHierarchyNode>('$ccls/call', {
          callType: CallType.All,
          callee: this.useCallee,
          hierarchy: true,
          id: element.id,
          levels: 1,
          qualified: this.qualified,
        });
    element.children = result.children;
    return result.children;
  }

  protected async onReveal(uri: Uri, position: Position): Promise<CallHierarchyNode> {
    return this.languageClient.sendRequest<CallHierarchyNode>('$ccls/call', {
      callType: CallType.All,
      callee: this.useCallee,
      hierarchy: true,
      levels: 2,
      position,
      qualified: this.qualified,
      textDocument: {
        uri: uri.toString(true),
      },
    });
  }

  private updateCallee(val: boolean) {
    this.useCallee = val;
    if (this.root) {
      this.root.children = [];
      this.onDidChangeEmitter.fire(this.root);
    }
  }
}
