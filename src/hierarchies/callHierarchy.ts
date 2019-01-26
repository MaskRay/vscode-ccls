import * as path from "path";
import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  TextEditor,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri
} from "vscode";
import { LanguageClient } from 'vscode-languageclient/lib/main';
import { Icon, IHierarchyNode } from '../types';
import { disposeAll, resourcePath, setContext } from "../utils";

enum CallType {
  Normal = 0,
  Base = 1,
  Derived = 2,
  All = CallType.Base | CallType.Derived // Normal and Base and Derived
}

function nodeIsIncomplete(node: CallHierarchyNode) {
  return node.children.length !== node.numChildren;
}

interface CallHierarchyNode extends IHierarchyNode {
  children: CallHierarchyNode[];
  callType: CallType;
}

export class CallHierarchyProvider implements TreeDataProvider<CallHierarchyNode>, Disposable {
  private readonly onDidChangeEmitter: EventEmitter<any> = new EventEmitter<any>();
  // tslint:disable-next-line:member-ordering
  public readonly onDidChangeTreeData: Event<any> = this.onDidChangeEmitter.event;

  private root?: CallHierarchyNode;
  private baseIcon: Icon;
  private derivedIcon: Icon;
  private _dispose: Disposable[] = [];

  constructor(
    readonly languageClient: LanguageClient
  ) {
    this.baseIcon = {
      dark: resourcePath("base-dark.svg"),
      light: resourcePath("base-light.svg")
    };
    this.derivedIcon = {
      dark: resourcePath("derived-dark.svg"),
      light: resourcePath("derived-light.svg")
    };

    this._dispose.push(commands.registerTextEditorCommand(
      'ccls.callHierarchy', this.cclsCallHierarchy, this
    ));
    this._dispose.push(commands.registerCommand(
      'ccls.closeCallHierarchy', this.closeCallHierarchy, this
    ));
  }

  public dispose() {
    disposeAll(this._dispose);
  }

  public getTreeItem(element: CallHierarchyNode): TreeItem {
    const ti = new TreeItem(element.name);
    ti.contextValue = 'cclsGoto';
    ti.command = {
      arguments: [element, element.numChildren > 0],
      command: 'ccls.hackGotoForTreeView',
      title: 'Goto',
    };
    if (element.numChildren > 0) {
      if (element.children.length > 0)
        ti.collapsibleState = TreeItemCollapsibleState.Expanded;
      else
        ti.collapsibleState = TreeItemCollapsibleState.Collapsed;
    }

    if (element.callType === CallType.Base) {
      ti.iconPath = this.baseIcon;
    } else if (element.callType === CallType.Derived) {
      ti.iconPath = this.derivedIcon;
    }

    if (element.location) {
      const elpath = Uri.parse(element.location.uri).path;
      ti.description = `${path.basename(elpath)}:${element.location.range.start.line + 1}`;
    }

    return ti;
  }

  public async getChildren(element?: CallHierarchyNode): Promise<CallHierarchyNode[]> {
    if (!this.root)
      return [];
    if (!element)
      return [this.root];
    if (!nodeIsIncomplete(element))
      return element.children;

    const result = await this.languageClient.sendRequest<CallHierarchyNode>('$ccls/call', {
      callType: CallType.All,
      callee: false,
      hierarchy: true,
      id: element.id,
      levels: 1,
      qualified: false,
    });
    element.children = result.children;
    return result.children;
  }

  private async cclsCallHierarchy(editor: TextEditor) {
    setContext('extension.ccls.callHierarchyVisible', true);
    const position = editor.selection.active;
    const uri = editor.document.uri;
    const callNode = await this.languageClient.sendRequest<CallHierarchyNode>(
      '$ccls/call',
      {
        callType: CallType.All,
        callee: false,
        hierarchy: true,
        levels: 2,
        position,
        qualified: false,
        textDocument: {
          uri: uri.toString(true),
        },
      }
    );
    this.root = callNode;
    this.onDidChangeEmitter.fire();
    commands.executeCommand("workbench.view.explorer");
  }

  private async closeCallHierarchy() {
    setContext('extension.ccls.callHierarchyVisible', false);
    this.root = undefined;
    this.onDidChangeEmitter.fire();
  }
}
