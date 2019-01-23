import {
  commands,
  Disposable,
  Event,
  EventEmitter,
  Position,
  Range,
  TextEditor,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
  workspace
} from "vscode";
import { LanguageClient } from "vscode-languageclient/lib/main";
import * as ls from "vscode-languageserver-types";
import { Icon } from "./types";
import { disposeAll, resourcePath, setContext } from "./utils";

export interface DataFlowHierarchyNode {
  // These properties come directly from the language server.
  id: number;
  location: ls.Location;
  children: DataFlowHierarchyNode[];
}

export class DataFlowHierarchyProvider implements TreeDataProvider<DataFlowHierarchyNode>, Disposable {
  private readonly onDidChangeEmitter: EventEmitter<any> = new EventEmitter<any>();
  // tslint:disable-next-line:member-ordering
  public readonly onDidChangeTreeData: Event<any> = this.onDidChangeEmitter.event;
  private root?: DataFlowHierarchyNode;
  private icon: Icon;
  private _dispose: Disposable[] = [];

  constructor(
    readonly languageClient: LanguageClient,
  ) {
    this.icon = {
      dark: resourcePath("base-dark.svg"),
      light: resourcePath("base-light.svg")
    };
    this._dispose.push(commands.registerCommand(
      'ccls.closeDataFlowHierarchy', this.closeHierarchy, this)
    );
    this._dispose.push(commands.registerTextEditorCommand(
      'ccls.dataFlowInto', this.showHierarchy, this)
    );
  }

  public dispose() {
    return disposeAll(this._dispose);
  }

  public async getTreeItem(element: DataFlowHierarchyNode): Promise<TreeItem> {
    let collapseState = TreeItemCollapsibleState.None;
    if (element.children.length > 0)
      collapseState = TreeItemCollapsibleState.Expanded;

    const parentFile = await workspace.openTextDocument(Uri.parse(element.location.uri));
    let label = parentFile.getText(
      new Range(
        new Position(element.location.range.start.line, element.location.range.start.character),
        new Position(element.location.range.end.line, element.location.range.end.character)
      )
    );

    if (element.location) {
      const path = Uri.parse(element.location.uri).path;
      const name = path.substr(path.lastIndexOf("/") + 1);
      label += ` (${name}:${element.location.range.start.line + 1})`;
    }

    const ti = new TreeItem(label, collapseState);
    ti.iconPath = this.icon;
    ti.command = {
      arguments: [element, element.children.length > 0],
      command: 'ccls.hackGotoForTreeView',
      title: 'Goto'
    };
    ti.contextValue = 'cclsGoto';

    return ti;
  }

  public getChildren(
    element?: DataFlowHierarchyNode
  ): DataFlowHierarchyNode[] | Thenable<DataFlowHierarchyNode[]> {
    if (!this.root)
      return [];
    if (!element)
      return [this.root];
    return element.children;
  }

  private closeHierarchy() {
    setContext('extension.ccls.dataFlowHierarchyVisible', false);
    this.root = undefined;
    this.onDidChangeEmitter.fire();
  }

  private async showHierarchy(editor: TextEditor) {
    setContext('extension.ccls.dataFlowHierarchyVisible', true);
    const position = editor.selection.active;
    const uri = editor.document.uri;
    const callNode = await this.languageClient.sendRequest<DataFlowHierarchyNode>(
      '$ccls/dataFlowInto',
      {
        position,
        textDocument: {
          uri: uri.toString(true),
        },
      }
    );
    this.root = callNode;
    this.onDidChangeEmitter.fire();
    commands.executeCommand("workbench.view.explorer");
  }
}
