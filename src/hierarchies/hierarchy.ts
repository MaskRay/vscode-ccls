import * as path from 'path';
import {
  commands,
  Event,
  EventEmitter,
  Position,
  TextEditor,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri
} from 'vscode';
import { Disposable, LanguageClient } from 'vscode-languageclient/lib/main';
import { IHierarchyNode } from '../types';
import { disposeAll, setContext } from '../utils';

function nodeIsIncomplete(node: IHierarchyNode) {
  return node.children.length !== node.numChildren;
}

export abstract class Hierarchy<T extends IHierarchyNode> implements TreeDataProvider<IHierarchyNode>, Disposable {
  protected abstract contextValue: string;
  protected _dispose: Disposable[] = [];

  protected readonly onDidChangeEmitter: EventEmitter<IHierarchyNode | null> = new EventEmitter<IHierarchyNode | null>();
  // tslint:disable-next-line:member-ordering
  public readonly onDidChangeTreeData: Event<IHierarchyNode | null> = this.onDidChangeEmitter.event;

  protected root?: T;

  constructor(
    readonly languageClient: LanguageClient,
    revealCmdName: string,
    closeCmdName: string
  ) {

    this._dispose.push(commands.registerTextEditorCommand(
      revealCmdName, this.reveal, this
    ));
    this._dispose.push(commands.registerCommand(
      closeCmdName, this.close, this
    ));
  }

  public dispose() {
    disposeAll(this._dispose);
  }

  public getTreeItem(element: T): TreeItem {
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

    const elpath = Uri.parse(element.location.uri).path;
    ti.description = `${path.basename(elpath)}:${element.location.range.start.line + 1}`;

    this.onTreeItem(ti, element);

    return ti;
  }

  public async getChildren(element?: T): Promise<IHierarchyNode[]> {
    if (!this.root)
      return [];
    if (!element)
      return [this.root];
    if (!nodeIsIncomplete(element))
      return element.children;

    return this.onGetChildren(element);
  }

  protected abstract onTreeItem(ti: TreeItem, element: T): void;

  protected abstract async onReveal(uri: Uri, position: Position): Promise<T>;

  protected abstract async onGetChildren(element: T): Promise<IHierarchyNode[]>;

  private async reveal(editor: TextEditor) {
    setContext(this.contextValue, true);
    const position = editor.selection.active;
    const uri = editor.document.uri;
    const callNode = await this.onReveal(uri, position);
    this.root = callNode;
    this.onDidChangeEmitter.fire(null);
    commands.executeCommand('workbench.view.explorer');
  }

  private close() {
    setContext(this.contextValue, false);
    this.root = undefined;
  }
}
