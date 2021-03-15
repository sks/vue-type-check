import * as path from "path";
import { TextDocument, Diagnostic } from "vscode-languageserver";
import { VueInterpolationMode } from "vue-language-server/dist/modes/template/interpolationMode";
import { getJavascriptMode } from "vue-language-server/dist/modes/script/javascript";
import { getServiceHost } from "vue-language-server/dist/services/typescriptService/serviceHost";
import { getLanguageModelCache } from "vue-language-server/dist/embeddedSupport/languageModelCache";
import { getVueDocumentRegions } from "vue-language-server/dist/embeddedSupport/embeddedSupport";
import tsModule from "typescript";
import ProgressBar from "progress";
import {
    getLines,
    formatLine,
    formatCursor,
    printError,
    printMessage,
    printLog,
} from "./print";
import { globSync, readFile, extractTargetFileExtension } from "./file-util";

interface Options {
    workspace: string;
    srcDir?: string;
    onlyTemplate?: boolean;
    onlyTypeScript?: boolean;
    excludeDir?: string | string[];
    failExit?: boolean;
    files: string[];
}

interface Source {
    docs: TextDocument[];
    workspace: string;
    onlyTemplate: boolean;
    failExit: boolean;
}

let validLanguages = ["vue"];

export async function check(options: Options) {
    const { workspace, onlyTemplate = false, onlyTypeScript = false, excludeDir, failExit = false, files = [] } = options;
    if (onlyTypeScript) {
        validLanguages = ["ts", "tsx", "vue"];
    }
    const srcDir = options.srcDir || options.workspace;
    const excludeDirs = typeof excludeDir === "string" ? [excludeDir] : excludeDir;
    const docs = await traverse(srcDir, onlyTypeScript, files, excludeDirs);

    await getDiagnostics({ docs, workspace, onlyTemplate, failExit });
}

async function traverse(
    root: string,
    onlyTypeScript: boolean,
    changedFiles: string[],
    excludeDirs?: string[],
): Promise<TextDocument[]> {
    let targetFiles = (changedFiles || []).length ? changedFiles as string[] : globSync(
        path.join(
            root,
            onlyTypeScript ? `**/*.{${validLanguages.join(",")}}` : "**/*.vue"
        )
    );

    if (excludeDirs) {
        const filterTargets = excludeDirs.map((dir) => path.resolve(dir)).join("|");
        targetFiles = targetFiles.filter((targetFile) =>
            !new RegExp(`^(?:${filterTargets}).*$`).test(targetFile)
        );
    }

    let files = await Promise.all(
        targetFiles.map(async (absFilePath) => {
            const src = await readFile(absFilePath);
            return {
                absFilePath,
                fileExt: extractTargetFileExtension(absFilePath) as string,
                src,
            };
        })
    );

    if (onlyTypeScript) {
        files = files.filter(({ src, fileExt }) => {
            if (fileExt !== "vue" || !hasScriptTag(src)) {
                return true;
            }
            return isTs(src) || isImportOtherTs(src);
        });
    }

    const docs = files.map(({ absFilePath, src, fileExt }) =>
        TextDocument.create(`file://${absFilePath}`, fileExt, 0, src)
    );

    return docs;
}

async function getDiagnostics({ docs, workspace, onlyTemplate, failExit }: Source) {
    const documentRegions = getLanguageModelCache(10, 60, (document) =>
        getVueDocumentRegions(document)
    );
    const scriptRegionDocuments = getLanguageModelCache(10, 60, (document) => {
        const vueDocument = documentRegions.refreshAndGet(document);
        return vueDocument.getSingleTypeDocument("script");
    });
    let hasError = false;
    let totalErrors = 0;
    try {
        const serviceHost = getServiceHost(
            tsModule,
            workspace,
            scriptRegionDocuments
        );
        const vueMode = new VueInterpolationMode(tsModule, serviceHost);
        const scriptMode = await getJavascriptMode(
            serviceHost,
            scriptRegionDocuments as any,
            workspace
        );
        const bar = new ProgressBar("checking [:bar] :current/:total", {
            total: docs.length,
            width: 20,
            clear: true,
        });
        for (const doc of docs) {
            const vueTplResults = vueMode.doValidation(doc);
            let scriptResults: Diagnostic[] = [];
            if (!onlyTemplate && scriptMode.doValidation) {
                scriptResults = scriptMode.doValidation(doc);
            }
            const results = vueTplResults.concat(scriptResults);
            if (results.length) {
                hasError = true;
                totalErrors += results.length;
                for (const result of results) {
                    const total = doc.lineCount;
                    const lines = getLines({
                        start: result.range.start.line,
                        end: result.range.end.line,
                        total,
                    });
                    printError(`Error in ${doc.uri}`);
                    printMessage(
                        `${result.range.start.line}:${result.range.start.character} ${result.message}`
                    );
                    for (const line of lines) {
                        const code = doc
                            .getText({
                                start: { line, character: 0 },
                                end: { line, character: Infinity },
                            })
                            .replace(/\n$/, "");
                        const isError = line === result.range.start.line;
                        printLog(formatLine({ number: line, code, isError }));
                        if (isError) {
                            printLog(formatCursor(result.range));
                        }
                    }
                }
            }
            bar.tick();
            if (hasError && failExit) {
                printMessage('Please run command locally to see the full list');
                break;
            }
        }
    } catch (error) {
        hasError = true;
        console.error(error);
    } finally {
        documentRegions.dispose();
        scriptRegionDocuments.dispose();
        if (!failExit) {
            printMessage(`Found: ${totalErrors} errors in ${docs.length} file(s)`);
        }
        process.exit(hasError ? 1 : 0);
    }
}

function hasScriptTag(src: string) {
    return /.*\<script.*\>/.test(src);
}

function isTs(src: string) {
    return /.*\<script.*lang="tsx?".*\>/.test(src);
}

function isImportOtherTs(src: string) {
    return /.*\<script.*src=".*".*\>/.test(src);
}
