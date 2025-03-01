import { ConfigurationReader, ExtensionConfigurationSettings } from '@cmt/config';
import { expect } from '@test/util';

function createConfig(conf: Partial<ExtensionConfigurationSettings>): ConfigurationReader {
    const ret = new ConfigurationReader({
        autoSelectActiveFolder: false,
        cmakePath: '',
        buildDirectory: '',
        installPrefix: null,
        sourceDirectory: '',
        saveBeforeBuild: true,
        buildBeforeRun: true,
        clearOutputBeforeBuild: true,
        configureSettings: {},
        cacheInit: null,
        preferredGenerators: [],
        generator: null,
        toolset: null,
        platform: null,
        configureArgs: [],
        buildArgs: [],
        buildToolArgs: [],
        parallelJobs: 0,
        ctestPath: '',
        ctest: {
            parallelJobs: 0
        },
        parseBuildDiagnostics: true,
        enabledOutputParsers: [],
        debugConfig: {},
        defaultVariants: {},
        ctestArgs: [],
        ctestDefaultArgs: [],
        environment: {},
        configureEnvironment: {},
        buildEnvironment: {},
        testEnvironment: {},
        mingwSearchDirs: [],
        emscriptenSearchDirs: [],
        mergedCompileCommands: null,
        copyCompileCommands: null,
        loadCompileCommands: true,
        configureOnOpen: null,
        configureOnEdit: true,
        skipConfigureIfCachePresent: null,
        useCMakeServer: true,
        cmakeCommunicationMode: 'automatic',
        showSystemKits: true,
        ignoreKitEnv: false,
        additionalKits: [],
        buildTask: false,
        outputLogEncoding: 'auto',
        enableTraceLogging: false,
        loggingLevel: 'info',
        touchbar: {
            visibility: "default"
        },
        statusbar: {
            advanced: {},
            visibility: "default"
        },
        useCMakePresets: 'never',
        allowCommentsInPresetsFile: false,
        launchBehavior: 'reuseTerminal',
        ignoreCMakeListsMissing: false
    });
    ret.updatePartial(conf);
    return ret;
}

suite('Configuration', () => {
    test('Create a read from a configuration', () => {
        const conf = createConfig({ parallelJobs: 13 });
        expect(conf.parallelJobs).to.eq(13);
    });

    test('Update a configuration', () => {
        const conf = createConfig({ parallelJobs: 22 });
        expect(conf.parallelJobs).to.eq(22);
        conf.updatePartial({ parallelJobs: 4 });
        expect(conf.parallelJobs).to.eq(4);
    });

    test('Listen for config changes', async () => {
        const conf = createConfig({ parallelJobs: 22 });
        let jobs = conf.parallelJobs;
        expect(jobs).to.eq(22);
        await new Promise<void>(resolve => {
            conf.onChange('parallelJobs', j => {
                jobs = j;
                resolve();
            });
            conf.updatePartial({ parallelJobs: 3 });
        });
        expect(jobs).to.eq(3);
    });

    async function didItComplete(promise: Promise<any>, timeout: number): Promise<boolean> {
        try {
            await new Promise<void>((resolve, reject) => {
                setTimeout(() => {
                    reject();
                }, timeout);
                void promise.then(() => {
                    resolve();
                });
            });
            return true;
        } catch {
            return false;
        }
    }

    test('Listen only fires for changing properties', async () => {
        const conf = createConfig({ parallelJobs: 3 });
        let changed = new Promise<void>(_ => {});  // never resolves
        conf.onChange('parallelJobs', _ => {
            changed = Promise.resolve();    // resolved
        });
        conf.updatePartial({ buildDirectory: 'foo' });
        let completed = await didItComplete(changed, 1000);
        expect(!completed, 'Update event should not fire');

        conf.updatePartial({ parallelJobs: 4 });
        completed = await didItComplete(changed, 1000);
        expect(completed, 'Update event should fire');
    });

    test('Unchanged values in partial update are unaffected', () => {
        const conf = createConfig({ parallelJobs: 5 });
        conf.updatePartial({ buildDirectory: 'Foo' });
        expect(conf.parallelJobs).to.eq(5);
    });
});
