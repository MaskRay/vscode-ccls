import {Position, Range, Selection, TextEditorRevealType, Uri, window, workspace} from 'vscode';

export async function jumpToUriAtPosition(
    uri: Uri, position: Position, preserveFocus: boolean) {
  const d = await workspace.openTextDocument(uri);
  if (!d) {
    window.activeTextEditor.revealRange(
        new Range(position, position), TextEditorRevealType.InCenter);
    window.activeTextEditor.selection = new Selection(position, position);
  } else {
    const e = await window.showTextDocument(d, undefined, preserveFocus);
    e.revealRange(
        new Range(position, position), TextEditorRevealType.InCenter);
    e.selection = new Selection(position, position);
  }
}
