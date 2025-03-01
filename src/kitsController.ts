'use strict';

import * as chokidar from 'chokidar';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';

import CMakeProject from '@cmt/cmakeProject';
import {
    Kit,
    descriptionForKit,
    readKitsFile,
    scanForKits,
    USER_KITS_FILEPATH,
    kitsPathForWorkspaceFolder,
    OLD_USER_KITS_FILEPATH,
    SpecialKits,
    SpecialKitsCount,
    getAdditionalKits
} from '@cmt/kit';
import * as logging from '@cmt/logging';
import paths from '@cmt/paths';
import { fs } from '@cmt/pr';
import rollbar from '@cmt/rollbar';
import { chokidarOnAnyChange, ProgressHandle, reportProgress } from '@cmt/util';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = logging.createLogger('kitsController');

export enum KitsReadMode {
    userKits,
    folderKits,
    allAvailable
}

// TODO: migrate all kit related things in extension.ts to this class.
export class KitsController {
    static minGWSearchDirs: string[] | undefined;
    /**
     * The kits available from the user-local kits file
     */
    static userKits: Kit[] = [];

    /**
     * The non-Kit entries (scan, unspecified)
     */
    static specialKits: Kit[] = [];

    private static checkingHaveKits = false;
    public static isScanningForKits() {
        return this.checkingHaveKits;
    }

    folderKits: Kit[] = [];
    additionalKits: Kit[] = [];

    private constructor(readonly cmakeProject: CMakeProject, private readonly _kitsWatcher: chokidar.FSWatcher) {}

    static async init(cmakeProject: CMakeProject) {
        if (KitsController.userKits.length === 0) {
            // never initialized before
            await KitsController.readUserKits(cmakeProject);
        }

        const expandedAdditionalKitFiles: string[] = await cmakeProject.getExpandedAdditionalKitFiles();
        const folderKitsFiles: string[] = [KitsController._workspaceKitsPath(cmakeProject.folder)].concat(expandedAdditionalKitFiles);
        const kitsWatcher = chokidar.watch(folderKitsFiles, { ignoreInitial: true, followSymlinks: false });
        const kitsController = new KitsController(cmakeProject, kitsWatcher);
        chokidarOnAnyChange(kitsWatcher, _ => rollbar.takePromise(localize('rereading.kits', 'Re-reading folder kits'), {},
            kitsController.readKits(KitsReadMode.folderKits)));
        cmakeProject.workspaceContext.config.onChange('additionalKits', () => kitsController.readKits(KitsReadMode.folderKits));

        await kitsController.readKits(KitsReadMode.folderKits);
        return kitsController;
    }

    dispose() {
        if (this._pickKitCancellationTokenSource) {
            this._pickKitCancellationTokenSource.dispose();
        }
        void this._kitsWatcher.close();
    }

    get availableKits() {
        console.assert(KitsController.length > 0, 'readKits should have been called at least once before.');
        if (this.cmakeProject.workspaceContext.config.showSystemKits) {
            return KitsController.specialKits.concat(this.folderKits.concat(this.additionalKits.concat(KitsController.userKits)));
        } else {
            return KitsController.specialKits.concat(this.folderKits);
        }
    }

    get folder() {
        return this.cmakeProject.folder;
    }

    static async readUserKits(cmakeProject: CMakeProject | undefined, progress?: ProgressHandle) {
        if (undefined === cmakeProject) {
            return;
        }
        // Read user kits if we are under userKits/allAvailable read mode, or if userKits is empty (which means userKits are never loaded)
        // Migrate kits from old pre-1.1.3 location
        try {
            if (await fs.exists(OLD_USER_KITS_FILEPATH) && !await fs.exists(USER_KITS_FILEPATH)) {
                rollbar.info(localize('migrating.kits.file', 'Migrating kits file'), { from: OLD_USER_KITS_FILEPATH, to: USER_KITS_FILEPATH });
                await fs.mkdir_p(path.dirname(USER_KITS_FILEPATH));
                await fs.rename(OLD_USER_KITS_FILEPATH, USER_KITS_FILEPATH);
            }
        } catch (e: any) {
            rollbar.exception(localize('failed.to.migrate.kits.file', 'Failed to migrate prior user-local kits file.'),
                e,
                { from: OLD_USER_KITS_FILEPATH, to: USER_KITS_FILEPATH });
        }

        // Special kits - include order is important
        KitsController.specialKits = [
            // Spcial __scanforkits__ kit used for invoking the "Scan for kits"
            { name: SpecialKits.ScanForKits },
            // Special __unspec__ kit for opting-out of kits
            { name: SpecialKits.Unspecified }
        ];

        // Load user-kits
        reportProgress(localize('loading.kits', 'Loading kits'), progress);

        KitsController.userKits = await readKitsFile(USER_KITS_FILEPATH, cmakeProject.workspaceContext.folder.uri.fsPath, await cmakeProject.getExpansionOptions());

        // Pruning requires user interaction, so it happens fully async
        KitsController._startPruneOutdatedKitsAsync(cmakeProject);
    }

    /**
     * Load the list of available kits from the filesystem. This will also update the kit loaded into the current backend if applicable.
     */
    async readKits(kitsReadMode = KitsReadMode.allAvailable, progress?: ProgressHandle) {
        if (kitsReadMode === KitsReadMode.userKits || kitsReadMode === KitsReadMode.allAvailable) {
            await KitsController.readUserKits(this.cmakeProject, progress);
        }

        if (kitsReadMode === KitsReadMode.folderKits || kitsReadMode === KitsReadMode.allAvailable) {
            // Read default folder kits
            this.folderKits = await readKitsFile(KitsController._workspaceKitsPath(this.folder), this.cmakeProject.workspaceContext.folder.uri.fsPath, await this.cmakeProject.getExpansionOptions());

            // Read additional folder kits
            this.additionalKits = await getAdditionalKits(this.cmakeProject);
        }

        // If the current kit was selected from the set that is updated with this call to readKits,
        // load it again to ensure it is up to date.
        const current = this.cmakeProject.activeKit;
        if (current) {
            const searchKits: Kit[] = (kitsReadMode === KitsReadMode.allAvailable) ? this.availableKits :
                (kitsReadMode === KitsReadMode.userKits) ? KitsController.userKits : this.folderKits.concat(this.additionalKits);
            const already_active_kit = searchKits.find(kit => kit.name === current.name);
            if (already_active_kit) {
                await this.setFolderActiveKit(already_active_kit);
            }
        }
    }

    /**
     * The path to the workspace-local kits file, dependent on the path to the
     * active workspace folder.
     */
    private static _workspaceKitsPath(folder: vscode.WorkspaceFolder): string {
        return kitsPathForWorkspaceFolder(folder);
    }

    /**
     * Set the current kit for the specified workspace folder
     * @param k The kit
     */
    async setFolderActiveKit(k: Kit | null): Promise<string> {
        const inst = this.cmakeProject;
        const raw_name = k ? k.name : SpecialKits.Unspecified;
        if (inst) {
            // Generate a message that we will show in the progress notification
            let message = '';
            switch (raw_name) {
                case SpecialKits.Unspecified:
                    // Empty string/unspec is un-setting the kit:
                    message = localize('unsetting.kit', 'Unsetting kit');
                    break;
                default:
                    // Everything else is just loading a kit:
                    message = localize('loading.kit', 'Loading kit {0}', raw_name);
                    break;
            }
            // Load the kit into the backend
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: message
                },
                () => inst.setKit(k)
            );
        }
        return raw_name;
    }

    async checkHaveKits(): Promise<boolean> {
        const avail = this.availableKits;
        if (avail.length > SpecialKitsCount) {
            // We have kits. Okay.
            return true;
        }
        if (!avail.find(kit => kit.name === SpecialKits.Unspecified)) {
            // We should _always_ have the 'UnspecifiedKit'.
            rollbar.error(localize('invalid.only.kit', 'Invalid only kit. Expected to find {0}', '"SpecialKits.Unspecified"'));
            return false;
        }

        // We don't have any kits defined. Scan for kits
        if (!KitsController.checkingHaveKits) {
            KitsController.checkingHaveKits = true;
            if (!KitsController.minGWSearchDirs) {
                await KitsController.scanForKits(this.cmakeProject);
            } else {
                await vscode.commands.executeCommand('cmake.scanForKits');
            }
            KitsController.checkingHaveKits = false;
            return true;
        } else {
            rollbar.error(localize('already.checking.kits', 'Already checking kits. Please try again later.'));
            return false;
        }
    }

    private _pickKitCancellationTokenSource: vscode.CancellationTokenSource = new vscode.CancellationTokenSource();

    /**
     * Show UI to allow the user to select an active kit
     */
    async selectKit(): Promise<boolean> {
        // Check that we have kits
        const state = await this.checkHaveKits();
        if (!state) {
            return false;
        }

        const avail = this.availableKits;
        log.debug(localize('start.selection.of.kits', 'Start selection of kits. Found {0} kits.', avail.length));

        interface KitItem extends vscode.QuickPickItem {
            kit: Kit;
        }
        log.debug(localize('opening.kit.selection', 'Opening kit selection QuickPick'));
        // Generate the quickpick items from our known kits
        const getKitName = (kit: Kit) => {
            switch (kit.name) {
                case SpecialKits.ScanForKits as string:
                    return `[${localize('scan.for.kits.button', 'Scan for kits')}]`;
                case SpecialKits.Unspecified as string:
                    return `[${localize('unspecified.kit.name', 'Unspecified')}]`;
                default:
                    return kit.name;
            }
        };
        const item_promises = avail.map(
            async (kit): Promise<KitItem> => ({
                label: getKitName(kit),
                description: await descriptionForKit(kit),
                kit
            })
        );
        const items = await Promise.all(item_promises);
        const chosen_kit = await vscode.window.showQuickPick(items,
            { placeHolder: localize('select.a.kit.placeholder', 'Select a Kit for {0}', this.folder.name) },
            this._pickKitCancellationTokenSource.token);
        this._pickKitCancellationTokenSource.dispose();
        this._pickKitCancellationTokenSource = new vscode.CancellationTokenSource();
        if (chosen_kit === undefined) {
            log.debug(localize('user.cancelled.kit.selection', 'User cancelled Kit selection'));
            // No selection was made
            return false;
        } else {
            if (chosen_kit.kit.name === SpecialKits.ScanForKits) {
                await KitsController.scanForKits(this.cmakeProject);
                return false;
            } else {
                log.debug(localize('user.selected.kit', 'User selected kit {0}', JSON.stringify(chosen_kit)));
                await this.setFolderActiveKit(chosen_kit.kit);
                return true;
            }
        }
    }

    /**
     * Set the current kit by name of the kit
     */
    async setKitByName(kitName: string) {
        if (!kitName) {
            kitName = SpecialKits.Unspecified;
        }
        const newKit: Kit | undefined = this.availableKits.find(kit => kit.name === kitName);
        await this.setFolderActiveKit(newKit || null);
        // if we are showing a quickpick menu...
        this._pickKitCancellationTokenSource.cancel();
    }

    /**
     * User-interactive kit pruning:
     *
     * This function will find all user-local kits that identify files that are
     * no longer present (such as compiler binaries), and will show a popup
     * notification to the user requesting an action.
     *
     * This function will not prune kits that have the `keep` field marked `true`
     *
     * If the user chooses to remove the kit, we call `_removeKit()` and erase it
     * from the user-local file.
     *
     * If the user chooses to keep teh kit, we call `_keepKit()` and set the
     * `keep` field on the kit to `true`.
     *
     * Always returns immediately.
     */
    private static _startPruneOutdatedKitsAsync(cmakeProject: CMakeProject) {
        // Iterate over _user_ kits. We don't care about workspace-local kits
        for (const kit of KitsController.userKits) {
            if (kit.keep === true) {
                // Kit is explicitly marked to be kept
                continue;
            }
            if (!kit.compilers) {
                // We only prune kits with a `compilers` field.
                continue;
            }
            // Accrue a list of promises that resolve to whether a give file exists
            interface FileInfo {
                path: string;
                exists: boolean;
            }
            const missing_paths_prs: Promise<FileInfo>[] = [];
            for (const lang in kit.compilers) {
                const comp_path = kit.compilers[lang];
                // Get a promise that resolve to whether the given path/name exists
                const exists_pr = path.isAbsolute(comp_path)
                    // Absolute path, just check if it exists
                    ? fs.exists(comp_path)
                    // Non-absolute. Check on $PATH
                    : paths.which(comp_path).then(v => v !== null);
                // Add it to the list
                missing_paths_prs.push(exists_pr.then(exists => ({ exists, path: comp_path })));
            }
            const pr = Promise.all(missing_paths_prs).then(async infos => {
                const missing = infos.find(i => !i.exists);
                if (!missing) {
                    return;
                }
                // This kit contains a compiler that does not exist. What to do?
                interface UpdateKitsItem extends vscode.MessageItem {
                    action: 'remove' | 'keep';
                }
                const chosen = await vscode.window.showInformationMessage<UpdateKitsItem>(
                    localize('kit.references.non-existent',
                        'The kit {0} references a non-existent compiler binary [{1}]. What would you like to do?',
                        `"${kit.name}"`, missing.path),
                    {},
                    {
                        action: 'remove',
                        title: localize('remove.it.button', 'Remove it')
                    },
                    {
                        action: 'keep',
                        title: localize('keep.it.button', 'Keep it')
                    }
                );
                if (chosen === undefined) {
                    return;
                }
                switch (chosen.action) {
                    case 'keep':
                        return KitsController._keepKit(cmakeProject, kit);
                    case 'remove':
                        return KitsController._removeKit(cmakeProject, kit);
                }
            });
            rollbar.takePromise(localize('pruning.kit', "Pruning kit"), { kit }, pr);
        }
    }

    /**
     * Mark a kit to be "kept". This set the `keep` value to `true` and writes
     * re-writes the user kits file.
     * @param kit The kit to mark
     */
    private static async _keepKit(cmakeProject: CMakeProject, kit: Kit) {
        const new_kits = KitsController.userKits.map(k => {
            if (k.name === kit.name) {
                return { ...k, keep: true };
            } else {
                return k;
            }
        });
        KitsController.userKits = new_kits;
        return KitsController._writeUserKitsFile(cmakeProject, new_kits);
    }

    /**
     * Remove a kit from the user-local kits.
     * @param kit The kit to remove
     */
    private static async _removeKit(cmakeProject: CMakeProject, kit: Kit) {
        const new_kits = KitsController.userKits.filter(k => k.name !== kit.name);
        KitsController.userKits = new_kits;
        return KitsController._writeUserKitsFile(cmakeProject, new_kits);
    }

    /**
     * Write the given kits the the user-local cmake-kits.json file.
     * @param kits The kits to write to the file.
     */
    private static async _writeUserKitsFile(cmakeProject: CMakeProject, kits: Kit[]) {
        log.debug(localize('saving.kits.to', 'Saving kits to {0}', USER_KITS_FILEPATH));

        // Remove the special kits
        const stripped_kits = kits.filter(kit => ((kit.name !== SpecialKits.ScanForKits) &&
            (kit.name !== SpecialKits.Unspecified)));

        // Sort the kits by name so they always appear in order in the file.
        const sorted_kits = stripped_kits.sort((a, b) => {
            if (a.name === b.name) {
                return 0;
            } else if (a.name < b.name) {
                return -1;
            } else {
                return 1;
            }
        });
        // Do the save.
        try {
            log.debug(localize('saving.new.kits.to', 'Saving new kits to {0}', USER_KITS_FILEPATH));
            // Create the directory where the kits will go
            await fs.mkdir_p(path.dirname(USER_KITS_FILEPATH));
            // Write the file
            await fs.writeFile(USER_KITS_FILEPATH, JSON.stringify(sorted_kits, null, 2));
        } catch (e: any) {
            // Failed to write the file. What to do...
            interface FailOptions extends vscode.MessageItem {
                do: 'retry' | 'cancel';
            }
            const pr = vscode.window.showErrorMessage<FailOptions>(
                `Failed to write kits file to disk: ${USER_KITS_FILEPATH}: ${e.toString()}`,
                {
                    title: localize('retry.button', 'Retry'),
                    do: 'retry'
                },
                {
                    title: localize('cancel.button', 'Cancel'),
                    do: 'cancel'
                })
                .then(choice => {
                    if (!choice) {
                        return false;
                    }
                    switch (choice.do) {
                        case 'retry':
                            return KitsController.scanForKits(cmakeProject);
                        case 'cancel':
                            return false;
                    }
                });
            // Don't block on writing re-trying the write
            rollbar.takePromise('retry-kit-save-fail', {}, pr);
            return false;
        }
    }

    /**
     * Rescan the system for kits and save them to the user-local kits file.
     * If cmake-tools-kits.json still has kits saved with the old format kit definition
     *     (visualStudio field as "VisualStudio.$(installation version)", as opposed to "$(unique installation id)"),
     * then ask if the user allows them to be deleted from the user-local kits file.
     *
     * If the user answers 'NO' or doesn't answer, nothing needs to be done, even if there is an active kit set,
     * because the extension is able to work with both definitions of a VS kit.
     * In this case, the new cmake-tools-kits.json may have some duplicate kits pointing to the same toolset.
     *
     * If the answer is 'YES' and if there is an active kit selected that is among the ones to be deleted,
     * then the user must also pick a new kit.
     *
     * @returns if any duplicate vs kits are removed.
     */
    static async scanForKits(cmakeProject: CMakeProject) {
        log.debug(localize('rescanning.for.kits', 'Rescanning for kits'));

        // Do the scan:
        const discovered_kits = await scanForKits(cmakeProject, { minGWSearchDirs: KitsController.minGWSearchDirs });

        // The list with the new definition user kits starts with the non VS ones,
        // which do not have any variations in the way they can be defined.
        const new_definition_user_kits = KitsController.userKits.filter(kit => !!!kit.visualStudio);

        // The VS kits saved so far in cmake-tools-kits.json
        const user_vs_kits = KitsController.userKits.filter(kit => !!kit.visualStudio);

        // Separate the VS kits based on old/new definition.
        const old_definition_vs_kits = [];
        user_vs_kits.forEach(kit => {
            if (kit.visualStudio && (kit.visualStudio.startsWith("VisualStudio.15") || kit.visualStudio.startsWith("VisualStudio.16"))) {
                old_definition_vs_kits.push(kit);
            } else {
                // The new definition VS kits can complete the final user kits list
                new_definition_user_kits.push(kit);
            }
        });

        let duplicateRemoved: boolean = false;
        if (old_definition_vs_kits.length > 1) {
            log.info(localize('found.duplicate.kits', 'Found Visual Studio kits with the old ids saved in the cmake-tools-kits.json.'));
            const yesButtonTitle: string = localize('yes.button', 'Yes');
            const chosen = await vscode.window.showInformationMessage<vscode.MessageItem>(
                localize('delete.duplicate.kits', 'Would you like to delete the duplicate Visual Studio kits from cmake-tools-kits.json?'),
                {
                    title: yesButtonTitle,
                    isCloseAffordance: true
                },
                {
                    title: localize('no.button', 'No'),
                    isCloseAffordance: true
                });

            if (chosen !== undefined && (chosen.title === yesButtonTitle)) {
                KitsController.userKits = new_definition_user_kits;
                duplicateRemoved = true;
            }
        }

        // Convert the kits into a by-name mapping so that we can restore the ones
        // we know about after the fact.
        // We only save the user-local kits: We don't want to save workspace kits
        // in the user kits file.
        const old_kits_by_name = KitsController.userKits.reduce(
            (acc, kit) => ({ ...acc, [kit.name]: kit }),
            {} as { [kit: string]: Kit }
        );

        // Update the new kits we know about.
        const new_kits_by_name = discovered_kits.reduce(
            (acc, kit) => KitsController.isBetterMatch(kit, acc[kit.name]) ? { ...acc, [kit.name]: kit } : acc,
            old_kits_by_name
        );

        const new_kits = Object.keys(new_kits_by_name).map(k => new_kits_by_name[k]);
        KitsController.userKits = new_kits;
        await KitsController._writeUserKitsFile(cmakeProject, new_kits);

        KitsController._startPruneOutdatedKitsAsync(cmakeProject);

        return duplicateRemoved;
    }

    static isBetterMatch(newKit: Kit, existingKit?: Kit): boolean {
        if (KitsController.isBetterClangCLDefinition(newKit, existingKit)) {
            return true;
        }
        return KitsController.isBetterCompilerMatch(newKit.compilers, existingKit?.compilers);
    }

    static isBetterClangCLDefinition(newKit: Kit, existingKit?: Kit): boolean {
        if (newKit.name.indexOf('MSVC CLI') >= 0) {
            return (existingKit?.visualStudioArchitecture === 'amd64') ||
                (existingKit?.preferredGenerator?.platform === 'amd64') ||
                (existingKit?.preferredGenerator?.toolset !== undefined && existingKit.preferredGenerator.toolset.indexOf('amd64') >= 0);
        }
        return false;
    }

    static isBetterCompilerMatch(newCompilers?: {[lang: string]: string}, existingCompilers?: {[lang: string]: string}): boolean {
        // Try to keep the best match (e.g. compilers for C and CXX exist)
        if (!existingCompilers) {
            return true;
        }
        if (newCompilers) {
            const newLangs = Object.keys(newCompilers);
            const existingLangs = Object.keys(existingCompilers);
            if (newLangs.length > existingLangs.length) {
                return true;
            }
            const path = process.env["PATH"]?.split(process.platform === 'win32' ? ';' : ':');
            if (path && newLangs.length === existingLangs.length) {
                // Prioritize compiler paths listed higher in the PATH environment variable.
                for (const p of path) {
                    const newScore = newLangs.reduce((acc, lang) => newCompilers[lang]?.startsWith(p) ? 1 + acc : acc, 0);
                    const existingScore = existingLangs.reduce((acc, lang) => existingCompilers[lang]?.startsWith(p) ? 1 + acc : acc, 0);
                    if (newScore > existingScore) {
                        return true;
                    } else if (existingScore > newScore) {
                        return false;
                    }
                }
            }
        }
        return false;
    };

}
