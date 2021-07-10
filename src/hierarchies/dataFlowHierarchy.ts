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
import { Icon, IHierarchyNode } from "../types";
import { disposeAll, resourcePath, setContext } from "../utils";
import { Hierarchy } from "./hierarchy";

interface DataFlowHierarchyNode extends IHierarchyNode {
  children: DataFlowHierarchyNode[];
}

export class DataFlowHierarchyProvider extends Hierarchy<DataFlowHierarchyNode> {
  protected contextValue = 'extension.ccls.dataFlowHierarchyVisible';
  private icon: Icon;

  constructor(
    readonly languageClient: LanguageClient,
  ) {
    super(languageClient, 'ccls.dataFlowInto', 'ccls.closeDataFlowHierarchy');
    this.icon = {
      dark: resourcePath("base-dark.svg"),
      light: resourcePath("base-light.svg")
    };
  }

  protected async onTreeItem(ti: TreeItem, element: DataFlowHierarchyNode) {

    const parentFile = await workspace.openTextDocument(Uri.parse(element.location.uri));
    ti.label = parentFile.getText(
      new Range(
        new Position(element.location.range.start.line, element.location.range.start.character),
        new Position(element.location.range.end.line, element.location.range.end.character)
      )
    );

    ti.iconPath = this.icon;
    ti.contextValue = 'cclsGoto';

  }

  protected async onGetChildren(
    element: DataFlowHierarchyNode
  ): Promise<DataFlowHierarchyNode[]> {
    return element.children;
  }

  protected async onReveal(uri: Uri, position: Position): Promise<DataFlowHierarchyNode> {
    return this.languageClient.sendRequest<DataFlowHierarchyNode>(
      '$ccls/dataFlowInto',
      {
        position,
        textDocument: {
          uri: uri.toString(true),
        },
      }
    );
  }
}
