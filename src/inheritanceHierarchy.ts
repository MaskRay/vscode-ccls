import {
  commands,
  Event,
  EventEmitter,
  TextEditor,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri
} from "vscode";
import { Disposable, LanguageClient } from "vscode-languageclient/lib/main";
import * as ls from "vscode-languageserver-types";
import { disposeAll, setContext } from "./utils";

export function InheritanceHierarchySetWantsDerived(node: InheritanceHierarchyNode, value: boolean) {
  node.wantsDerived = value;
  node.children.map((c) => InheritanceHierarchySetWantsDerived(c, value));
}

export interface InheritanceHierarchyNode {
  id: any;
  kind: number;
  name: string;
  location?: ls.Location;
  numChildren: number;
  children: InheritanceHierarchyNode[];

  /** If true and children need to be expanded derived will be used, otherwise base will be used. */
  wantsDerived: boolean;
}

export class InheritanceHierarchyProvider implements
    TreeDataProvider<InheritanceHierarchyNode>, Disposable {

  private readonly onDidChangeEmitter: EventEmitter<any> = new EventEmitter<any>();
  // tslint:disable-next-line:member-ordering
  public readonly onDidChangeTreeData: Event<any> = this.onDidChangeEmitter.event;
  private root?: InheritanceHierarchyNode;
  private _dispose: Disposable[] = [];

  constructor(readonly languageClient: LanguageClient) {
    this._dispose.push(commands.registerTextEditorCommand(
      "ccls.inheritanceHierarchy", this.cclsInheritanceHierarchy, this
    ));
    this._dispose.push(commands.registerCommand(
      "ccls.closeInheritanceHierarchy", this.closeInheritanceHierarchy, this
      ));
  }

  public dispose() {
    disposeAll(this._dispose);
  }

  public getTreeItem(element: InheritanceHierarchyNode): TreeItem {
    const kBaseName = '[[Base]]';

    let collapseState = TreeItemCollapsibleState.None;
    if (element.numChildren > 0) {
      if (element.children.length > 0 && element.name !== kBaseName)
        collapseState = TreeItemCollapsibleState.Expanded;
      else
        collapseState = TreeItemCollapsibleState.Collapsed;
    }

    let label = element.name;
    if (element.name !== kBaseName && element.location) {
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
      label,
    };
  }

  public async getChildren(element?: InheritanceHierarchyNode):
    Promise<InheritanceHierarchyNode[]> {
    if (!this.root)
      return [];
    if (!element)
      return [this.root];
    if (element.numChildren === element.children.length)
      return element.children;

    const result = await this.languageClient.sendRequest<InheritanceHierarchyNode>(
      '$ccls/inheritance', {
        derived: element.wantsDerived,
        hierarchy: true,
        id: element.id,
        kind: element.kind,
        levels: 1,
        qualified: false,
    });
    element.children = result.children;
    result.children.map((c) => InheritanceHierarchySetWantsDerived(c, element.wantsDerived));
    return result.children;
  }

  private async cclsInheritanceHierarchy(editor: TextEditor) {
    setContext('extension.ccls.inheritanceHierarchyVisible', true);

    const position = editor.selection.active;
    const uri = editor.document.uri;
    const entry = await this.languageClient.sendRequest<InheritanceHierarchyNode>('$ccls/inheritance', {
      derived: true,
      hierarchy: true,
      levels: 1,
      position,
      qualified: false,
      textDocument: {
        uri: uri.toString(true),
      },
    });
    InheritanceHierarchySetWantsDerived(entry, true);

    const parentEntry = await this.languageClient.sendRequest<InheritanceHierarchyNode>(
      '$ccls/inheritance',
      {
        derived: false,
        hierarchy: true,
        id: entry.id,
        kind: entry.kind,
        levels: 1,
        qualified: false,
      }
    );
    if (parentEntry.numChildren > 0) {
      const parentWrapper: InheritanceHierarchyNode = {
        children: parentEntry.children,
        id: undefined,
        kind: -1,
        location: undefined,
        name: '[[Base]]',
        numChildren: parentEntry.children.length,
        wantsDerived: false
      };
      InheritanceHierarchySetWantsDerived(
          parentWrapper, false);
      entry.children.unshift(parentWrapper);
      entry.numChildren += 1;
    }

    this.root = entry;
    this.onDidChangeEmitter.fire();
    commands.executeCommand("workbench.view.explorer");
  }

  private async closeInheritanceHierarchy() {
    setContext('extension.ccls.inheritanceHierarchyVisible', false);
    this.root = undefined;
    this.onDidChangeEmitter.fire();
  }
}
