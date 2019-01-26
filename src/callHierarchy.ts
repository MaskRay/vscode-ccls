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
import { Icon, IHierarchyNode } from './types';
import { disposeAll, resourcePath, setContext } from "./utils";

enum CallType {
  Normal = 0,
  Base = 1,
  Derived = 2,
  All = 3 // Normal & Base & Derived
}

interface CallHierarchyNode extends IHierarchyNode {
  callType: CallType;

  // If |numChildren| != |children.length|, then the node has not been expanded
  // and is incomplete - we need to send a new request to expand it.
  numChildren: number;
  children: CallHierarchyNode[];
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
    let collapseState = TreeItemCollapsibleState.None;
    if (element.numChildren > 0) {
      if (element.children.length > 0)
        collapseState = TreeItemCollapsibleState.Expanded;
      else
        collapseState = TreeItemCollapsibleState.Collapsed;
    }

    let iconPath: Icon = {
      dark: "",
      light: ""
    };
    if (element.callType === CallType.Base) {
      iconPath = this.baseIcon;
    } else if (element.callType === CallType.Derived) {
      iconPath = this.derivedIcon;
    }

    let label = element.name;
    if (element.location) {
      const path = Uri.parse(element.location.uri).path;
      const name = path.substr(path.lastIndexOf('/') + 1);
      label += ` (${name}:${element.location.range.start.line + 1})`;
    }

    return {
      collapsibleState: collapseState,
      command: {
        arguments: [element, element.numChildren > 0],
        command: 'ccls.hackGotoForTreeView',
        title: 'Goto',
      },
      contextValue: 'cclsGoto',
      iconPath,
      label,
    };
  }

  public async getChildren(element?: CallHierarchyNode): Promise<CallHierarchyNode[]> {
    if (!this.root)
      return [];
    if (!element)
      return [this.root];
    if (element.numChildren === element.children.length)
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
        callType: 0x1 | 0x2,
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
