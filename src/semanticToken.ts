import {
    SemanticTokens,
    SemanticTokensLegend,
    TextDocument,
    Range,
    Position,
    CancellationToken
} from "vscode";
import { LanguageClient } from "vscode-languageclient/node";


export enum TokenModifier {
    Declaration = 0,
    Definition = 1,
    Readonly = 2,
    Static = 3,
    Deprecated = 4,
    Abstract = 5,
    Async = 6,
    Modification = 7,
    Documentation = 8,
    DefaultLibrary = 9,
    // Scope modifiers
    FunctionScope = 10,
    ClassScope = 11,
    NamespaceScope = 12,
    // Access modifiers
    Read = 13,
    Write = 14,
    // Rainbow ID modifiers
    Id0 = 15,
    Id1 = 16,
    Id2 = 17,
    Id3 = 18,
    Id4 = 19,
    Id5 = 20,
    Id6 = 21,
    Id7 = 22,
    Id8 = 23,
    Id9 = 24,
    Id10 = 25,
    Id11 = 26,
    Id12 = 27,
    Id13 = 28,
    Id14 = 29,
    Id15 = 30,
    Id16 = 31,
    Id17 = 32,
    Id18 = 33,
    Id19 = 34
}

export class SemanticTokenProvider {
    private legend: SemanticTokensLegend;

    constructor(private client: LanguageClient) {
        this.legend = new SemanticTokensLegend(
            [
                'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
                'parameter', 'variable', 'property', 'enumMember', 'event', 'function',
                'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number',
                'regexp', 'operator'
            ],
            [
                'declaration', 'definition', 'readonly', 'static', 'deprecated',
                'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
                'functionScope', 'classScope', 'namespaceScope',
                'read', 'write',
                'id0', 'id1', 'id2', 'id3', 'id4', 'id5', 'id6', 'id7', 'id8', 'id9',
                'id10', 'id11', 'id12', 'id13', 'id14', 'id15', 'id16', 'id17', 'id18', 'id19'
            ]
        );
    }

    getLegend(): SemanticTokensLegend {
        return this.legend;
    }

    async provideDocumentSemanticTokens(
        document: TextDocument,
        token: CancellationToken
    ): Promise<SemanticTokens | null> {
        return this.provideRangeSemanticTokens(document, new Range(0, 0, document.lineCount, 0), token);
    }

    async provideRangeSemanticTokens(
        document: TextDocument,
        range: Range,
        token: CancellationToken
    ): Promise<SemanticTokens | null> {
        try {
            const result = await this.client.sendRequest<SemanticTokens>(
                'textDocument/semanticTokens/range',
                {
                    textDocument: { uri: document.uri.toString(true) },
                    range: this.client.code2ProtocolConverter.asRange(range)
                },
                token
            );

            if (!result || !result.data) {
                return null;
            }

            return new SemanticTokens(result.data, result.resultId);
        } catch (error) {
            console.error('Error providing range semantic tokens:', error);
            return null;
        }
    }
}