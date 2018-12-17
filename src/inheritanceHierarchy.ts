import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Uri } from "vscode";
import { LanguageClient } from "vscode-languageclient/lib/main";
import * as ls from "vscode-languageserver-types";

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
  TreeDataProvider<InheritanceHierarchyNode> {

  public readonly onDidChangeEmitter: EventEmitter<any> = new EventEmitter<any>();
  public readonly onDidChangeTreeData: Event<any> = this.onDidChangeEmitter.event;
  public root?: InheritanceHierarchyNode;

  constructor(readonly languageClient: LanguageClient) { }

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
}
