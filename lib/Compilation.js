/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const asyncLib = require("neo-async");
const {
	HookMap,
	SyncHook,
	SyncBailHook,
	SyncWaterfallHook,
	AsyncSeriesHook,
	AsyncSeriesBailHook,
	AsyncParallelHook
} = require("tapable");
const util = require("util");
const { CachedSource } = require("webpack-sources");
const { MultiItemCache } = require("./CacheFacade");
const Chunk = require("./Chunk");
const ChunkGraph = require("./ChunkGraph");
const ChunkGroup = require("./ChunkGroup");
const ChunkRenderError = require("./ChunkRenderError");
const ChunkTemplate = require("./ChunkTemplate");
const CodeGenerationError = require("./CodeGenerationError");
const CodeGenerationResults = require("./CodeGenerationResults");
const Dependency = require("./Dependency");
const DependencyTemplates = require("./DependencyTemplates");
const Entrypoint = require("./Entrypoint");
const ErrorHelpers = require("./ErrorHelpers");
const FileSystemInfo = require("./FileSystemInfo");
const {
	connectChunkGroupAndChunk,
	connectChunkGroupParentAndChild
} = require("./GraphHelpers");
const {
	makeWebpackError,
	tryRunOrWebpackError
} = require("./HookWebpackError");
const MainTemplate = require("./MainTemplate");
const Module = require("./Module");
const ModuleDependencyError = require("./ModuleDependencyError");
const ModuleDependencyWarning = require("./ModuleDependencyWarning");
const ModuleGraph = require("./ModuleGraph");
const ModuleHashingError = require("./ModuleHashingError");
const ModuleNotFoundError = require("./ModuleNotFoundError");
const ModuleProfile = require("./ModuleProfile");
const ModuleRestoreError = require("./ModuleRestoreError");
const ModuleStoreError = require("./ModuleStoreError");
const ModuleTemplate = require("./ModuleTemplate");
const { WEBPACK_MODULE_TYPE_RUNTIME } = require("./ModuleTypeConstants");
const RuntimeGlobals = require("./RuntimeGlobals");
const RuntimeTemplate = require("./RuntimeTemplate");
const Stats = require("./Stats");
const WebpackError = require("./WebpackError");
const buildChunkGraph = require("./buildChunkGraph");
const BuildCycleError = require("./errors/BuildCycleError");
const { Logger, LogType } = require("./logging/Logger");
const StatsFactory = require("./stats/StatsFactory");
const StatsPrinter = require("./stats/StatsPrinter");
const { equals: arrayEquals } = require("./util/ArrayHelpers");
const AsyncQueue = require("./util/AsyncQueue");
const LazySet = require("./util/LazySet");
const { getOrInsert } = require("./util/MapHelpers");
const WeakTupleMap = require("./util/WeakTupleMap");
const { cachedCleverMerge } = require("./util/cleverMerge");
const {
	compareLocations,
	concatComparators,
	compareSelect,
	compareIds,
	compareStringsNumeric,
	compareModulesByIdentifier
} = require("./util/comparators");
const createHash = require("./util/createHash");
const {
	arrayToSetDeprecation,
	soonFrozenObjectDeprecation,
	createFakeHook
} = require("./util/deprecation");
const processAsyncTree = require("./util/processAsyncTree");
const { getRuntimeKey } = require("./util/runtime");
const { isSourceEqual } = require("./util/source");
const EMPTY_ASSET_INFO = Object.freeze({});

const esmDependencyCategory = "esm";

// TODO webpack 6: remove
const deprecatedNormalModuleLoaderHook = util.deprecate(
	 
	compilation =>
		require("./NormalModule").getCompilationHooks(compilation).loader,
	"Compilation.hooks.normalModuleLoader was moved to NormalModule.getCompilationHooks(compilation).loader",
	"DEP_WEBPACK_COMPILATION_NORMAL_MODULE_LOADER_HOOK"
);

// TODO webpack 6: remove
 
const defineRemovedModuleTemplates = moduleTemplates => {
	Object.defineProperties(moduleTemplates, {
		asset: {
			enumerable: false,
			configurable: false,
			get: () => {
				throw new WebpackError(
					"Compilation.moduleTemplates.asset has been removed"
				);
			}
		},
		webassembly: {
			enumerable: false,
			configurable: false,
			get: () => {
				throw new WebpackError(
					"Compilation.moduleTemplates.webassembly has been removed"
				);
			}
		}
	});
	moduleTemplates = undefined;
};

const byId = compareSelect(c => c.id, compareIds);

const byNameOrHash = concatComparators(
	compareSelect(c => c.name, compareIds),
	compareSelect(c => c.fullHash, compareIds)
);

const byMessage = compareSelect(err => `${err.message}`, compareStringsNumeric);

const byModule = compareSelect(
	err => (err.module && err.module.identifier()) || "",
	compareStringsNumeric
);

const byLocation = compareSelect(err => err.loc, compareLocations);

const compareErrors = concatComparators(byModule, byLocation, byMessage);


const unsafeCacheDependencies = new WeakMap();


const unsafeCacheData = new WeakMap();

class Compilation {
	 
	constructor(compiler, params) {
		this._backCompat = compiler._backCompat;

		const getNormalModuleLoader = () => deprecatedNormalModuleLoaderHook(this);
		
		
		const processAssetsHook = new AsyncSeriesHook(["assets"]);

		let savedAssets = new Set();
	 
		const popNewAssets = assets => {
			let newAssets;
			for (const file of Object.keys(assets)) {
				if (savedAssets.has(file)) continue;
				if (newAssets === undefined) {
					newAssets = Object.create(null);
				}
				newAssets[file] = assets[file];
				savedAssets.add(file);
			}
			return newAssets;
		};
		processAssetsHook.intercept({
			name: "Compilation",
			call: () => {
				savedAssets = new Set(Object.keys(this.assets));
			},
			register: tap => {
				const { type, name } = tap;
				// @ts-ignore
				const { fn, additionalAssets, ...remainingTap } = tap;
				const additionalAssetsFn =
					additionalAssets === true ? fn : additionalAssets;
				const processedAssets = additionalAssetsFn ? new WeakSet() : undefined;
				switch (type) {
					case "sync":
						if (additionalAssetsFn) {
							this.hooks.processAdditionalAssets.tap(name, assets => {
								if (processedAssets.has(this.assets))
									additionalAssetsFn(assets);
							});
						}
						return {
							...remainingTap,
							type: "async",
							fn: (assets, callback) => {
								try {
									fn(assets);
								} catch (err) {
									return callback(err);
								}
								if (processedAssets !== undefined)
									processedAssets.add(this.assets);
								const newAssets = popNewAssets(assets);
								if (newAssets !== undefined) {
									this.hooks.processAdditionalAssets.callAsync(
										newAssets,
										callback
									);
									return;
								}
								callback();
							}
						};
					case "async":
						if (additionalAssetsFn) {
							this.hooks.processAdditionalAssets.tapAsync(
								name,
								(assets, callback) => {
									if (processedAssets.has(this.assets))
										return additionalAssetsFn(assets, callback);
									callback();
								}
							);
						}
						return {
							...remainingTap,
							fn: (assets, callback) => {
								fn(assets, err => {
									if (err) return callback(err);
									if (processedAssets !== undefined)
										processedAssets.add(this.assets);
									const newAssets = popNewAssets(assets);
									if (newAssets !== undefined) {
										this.hooks.processAdditionalAssets.callAsync(
											newAssets,
											callback
										);
										return;
									}
									callback();
								});
							}
						};
					case "promise":
						if (additionalAssetsFn) {
							this.hooks.processAdditionalAssets.tapPromise(name, assets => {
								if (processedAssets.has(this.assets))
									return additionalAssetsFn(assets);
								return Promise.resolve();
							});
						}
						return {
							...remainingTap,
							fn: assets => {
								const p = fn(assets);
								if (!p || !p.then) return p;
								return p.then(() => {
									if (processedAssets !== undefined)
										processedAssets.add(this.assets);
									const newAssets = popNewAssets(assets);
									if (newAssets !== undefined) {
										return this.hooks.processAdditionalAssets.promise(
											newAssets
										);
									}
								});
							}
						};
				}
			}
		});

		
		const afterProcessAssetsHook = new SyncHook(["assets"]);

		 
		const createProcessAssetsHook = (name, stage, getArgs, code) => {
			if (!this._backCompat && code) return;
		 
			const errorMessage =
				reason => `Can't automatically convert plugin using Compilation.hooks.${name} to Compilation.hooks.processAssets because ${reason}.
BREAKING CHANGE: Asset processing hooks in Compilation has been merged into a single Compilation.hooks.processAssets hook.`;
			const getOptions = options => {
				if (typeof options === "string") options = { name: options };
				if (options.stage) {
					throw new Error(errorMessage("it's using the 'stage' option"));
				}
				return { ...options, stage };
			};
			return createFakeHook(
				{
					name,
					
					intercept(interceptor) {
						throw new Error(errorMessage("it's using 'intercept'"));
					},
					
					tap: (options, fn) => {
						processAssetsHook.tap(getOptions(options), () => fn(...getArgs()));
					},
					
					tapAsync: (options, fn) => {
						processAssetsHook.tapAsync(
							getOptions(options),
							(assets, callback) =>
								 (fn)(...getArgs(), callback)
						);
					},
					
					tapPromise: (options, fn) => {
						processAssetsHook.tapPromise(getOptions(options), () =>
							fn(...getArgs())
						);
					}
				},
				`${name} is deprecated (use Compilation.hooks.processAssets instead and use one of Compilation.PROCESS_ASSETS_STAGE_* as stage option)`,
				code
			);
		};
		this.hooks = Object.freeze({
			
			buildModule: new SyncHook(["module"]),
			
			rebuildModule: new SyncHook(["module"]),
			
			failedModule: new SyncHook(["module", "error"]),
			
			succeedModule: new SyncHook(["module"]),
			
			stillValidModule: new SyncHook(["module"]),

			
			addEntry: new SyncHook(["entry", "options"]),
			
			failedEntry: new SyncHook(["entry", "options", "error"]),
			
			succeedEntry: new SyncHook(["entry", "options", "module"]),

			
			dependencyReferencedExports: new SyncWaterfallHook([
				"referencedExports",
				"dependency",
				"runtime"
			]),

			
			executeModule: new SyncHook(["options", "context"]),
			
			prepareModuleExecution: new AsyncParallelHook(["options", "context"]),

			
			finishModules: new AsyncSeriesHook(["modules"]),
			
			finishRebuildingModule: new AsyncSeriesHook(["module"]),
			
			unseal: new SyncHook([]),
			
			seal: new SyncHook([]),

			
			beforeChunks: new SyncHook([]), 
			afterChunks: new SyncHook(["chunks"]),

			
			optimizeDependencies: new SyncBailHook(["modules"]),
			
			afterOptimizeDependencies: new SyncHook(["modules"]),

			
			optimize: new SyncHook([]),
			
			optimizeModules: new SyncBailHook(["modules"]),
			
			afterOptimizeModules: new SyncHook(["modules"]),

			
			optimizeChunks: new SyncBailHook(["chunks", "chunkGroups"]),
			
			afterOptimizeChunks: new SyncHook(["chunks", "chunkGroups"]),

			
			optimizeTree: new AsyncSeriesHook(["chunks", "modules"]),
			
			afterOptimizeTree: new SyncHook(["chunks", "modules"]),

			
			optimizeChunkModules: new AsyncSeriesBailHook(["chunks", "modules"]),
			
			afterOptimizeChunkModules: new SyncHook(["chunks", "modules"]),
			
			shouldRecord: new SyncBailHook([]),

			
			additionalChunkRuntimeRequirements: new SyncHook([
				"chunk",
				"runtimeRequirements",
				"context"
			]),
			
			runtimeRequirementInChunk: new HookMap(
				() => new SyncBailHook(["chunk", "runtimeRequirements", "context"])
			),
			
			additionalModuleRuntimeRequirements: new SyncHook([
				"module",
				"runtimeRequirements",
				"context"
			]),
			
			runtimeRequirementInModule: new HookMap(
				() => new SyncBailHook(["module", "runtimeRequirements", "context"])
			),
			
			additionalTreeRuntimeRequirements: new SyncHook([
				"chunk",
				"runtimeRequirements",
				"context"
			]),
			
			runtimeRequirementInTree: new HookMap(
				() => new SyncBailHook(["chunk", "runtimeRequirements", "context"])
			),

			
			runtimeModule: new SyncHook(["module", "chunk"]),

			
			reviveModules: new SyncHook(["modules", "records"]),
			
			beforeModuleIds: new SyncHook(["modules"]),
			
			moduleIds: new SyncHook(["modules"]),
			
			optimizeModuleIds: new SyncHook(["modules"]),
			
			afterOptimizeModuleIds: new SyncHook(["modules"]),

			
			reviveChunks: new SyncHook(["chunks", "records"]),
			
			beforeChunkIds: new SyncHook(["chunks"]),
			
			chunkIds: new SyncHook(["chunks"]),
			
			optimizeChunkIds: new SyncHook(["chunks"]),
			
			afterOptimizeChunkIds: new SyncHook(["chunks"]),

			
			recordModules: new SyncHook(["modules", "records"]),
			
			recordChunks: new SyncHook(["chunks", "records"]),

			
			optimizeCodeGeneration: new SyncHook(["modules"]),

			
			beforeModuleHash: new SyncHook([]),
			
			afterModuleHash: new SyncHook([]),

			
			beforeCodeGeneration: new SyncHook([]),
			
			afterCodeGeneration: new SyncHook([]),

			
			beforeRuntimeRequirements: new SyncHook([]),
			
			afterRuntimeRequirements: new SyncHook([]),

			
			beforeHash: new SyncHook([]),
			
			contentHash: new SyncHook(["chunk"]),
			
			afterHash: new SyncHook([]),
			
			recordHash: new SyncHook(["records"]),
			
			record: new SyncHook(["compilation", "records"]),

			
			beforeModuleAssets: new SyncHook([]),
			
			shouldGenerateChunkAssets: new SyncBailHook([]),
			
			beforeChunkAssets: new SyncHook([]),
			// TODO webpack 6 remove
			
			additionalChunkAssets: createProcessAssetsHook(
				"additionalChunkAssets",
				Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
				() => [this.chunks],
				"DEP_WEBPACK_COMPILATION_ADDITIONAL_CHUNK_ASSETS"
			),

			// TODO webpack 6 deprecate
			
			additionalAssets: createProcessAssetsHook(
				"additionalAssets",
				Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
				() => []
			),
			// TODO webpack 6 remove
			
			optimizeChunkAssets: createProcessAssetsHook(
				"optimizeChunkAssets",
				Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
				() => [this.chunks],
				"DEP_WEBPACK_COMPILATION_OPTIMIZE_CHUNK_ASSETS"
			),
			// TODO webpack 6 remove
			
			afterOptimizeChunkAssets: createProcessAssetsHook(
				"afterOptimizeChunkAssets",
				Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE + 1,
				() => [this.chunks],
				"DEP_WEBPACK_COMPILATION_AFTER_OPTIMIZE_CHUNK_ASSETS"
			),
			// TODO webpack 6 deprecate
			
			optimizeAssets: processAssetsHook,
			// TODO webpack 6 deprecate
			
			afterOptimizeAssets: afterProcessAssetsHook,

			processAssets: processAssetsHook,
			afterProcessAssets: afterProcessAssetsHook,
			
			processAdditionalAssets: new AsyncSeriesHook(["assets"]),

			
			needAdditionalSeal: new SyncBailHook([]),
			
			afterSeal: new AsyncSeriesHook([]),

			
			renderManifest: new SyncWaterfallHook(["result", "options"]),

			
			fullHash: new SyncHook(["hash"]),
			
			chunkHash: new SyncHook(["chunk", "chunkHash", "ChunkHashContext"]),

			
			moduleAsset: new SyncHook(["module", "filename"]),
			
			chunkAsset: new SyncHook(["chunk", "filename"]),

			
			assetPath: new SyncWaterfallHook(["path", "options", "assetInfo"]),

			
			needAdditionalPass: new SyncBailHook([]),

			
			childCompiler: new SyncHook([
				"childCompiler",
				"compilerName",
				"compilerIndex"
			]),

			
			log: new SyncBailHook(["origin", "logEntry"]),

			
			processWarnings: new SyncWaterfallHook(["warnings"]),
			
			processErrors: new SyncWaterfallHook(["errors"]),

			
			statsPreset: new HookMap(() => new SyncHook(["options", "context"])),
			
			statsNormalize: new SyncHook(["options", "context"]),
			
			statsFactory: new SyncHook(["statsFactory", "options"]),
			
			statsPrinter: new SyncHook(["statsPrinter", "options"]),

			get normalModuleLoader() {
				return getNormalModuleLoader();
			}
		});
		
		this.name = undefined;
		
		this.startTime = undefined;
		
		this.endTime = undefined;
		
		this.compiler = compiler;
		this.resolverFactory = compiler.resolverFactory;
		
		this.inputFileSystem =
			
			(compiler.inputFileSystem);
		this.fileSystemInfo = new FileSystemInfo(this.inputFileSystem, {
			unmanagedPaths: compiler.unmanagedPaths,
			managedPaths: compiler.managedPaths,
			immutablePaths: compiler.immutablePaths,
			logger: this.getLogger("webpack.FileSystemInfo"),
			hashFunction: compiler.options.output.hashFunction
		});
		if (compiler.fileTimestamps) {
			this.fileSystemInfo.addFileTimestamps(compiler.fileTimestamps, true);
		}
		if (compiler.contextTimestamps) {
			this.fileSystemInfo.addContextTimestamps(
				compiler.contextTimestamps,
				true
			);
		}
		
		this.valueCacheVersions = new Map();
		this.requestShortener = compiler.requestShortener;
		this.compilerPath = compiler.compilerPath;

		this.logger = this.getLogger("webpack.Compilation");

		const options =  (compiler.options);
		this.options = options;
		this.outputOptions = options && options.output;
		
		this.bail = (options && options.bail) || false;
		
		this.profile = (options && options.profile) || false;

		this.params = params;
		this.mainTemplate = new MainTemplate(this.outputOptions, this);
		this.chunkTemplate = new ChunkTemplate(this.outputOptions, this);
		this.runtimeTemplate = new RuntimeTemplate(
			this,
			this.outputOptions,
			this.requestShortener
		);
		
		this.moduleTemplates = {
			javascript: new ModuleTemplate(this.runtimeTemplate, this)
		};
		defineRemovedModuleTemplates(this.moduleTemplates);

		
		this.moduleMemCaches = undefined;
		
		this.moduleMemCaches2 = undefined;
		this.moduleGraph = new ModuleGraph();
		
		this.chunkGraph = undefined;
		
		this.codeGenerationResults = undefined;

		
		this.processDependenciesQueue = new AsyncQueue({
			name: "processDependencies",
			parallelism: options.parallelism || 100,
			processor: this._processModuleDependencies.bind(this)
		});
		
		this.addModuleQueue = new AsyncQueue({
			name: "addModule",
			parent: this.processDependenciesQueue,
			getKey: module => module.identifier(),
			processor: this._addModule.bind(this)
		});
		
		this.factorizeQueue = new AsyncQueue({
			name: "factorize",
			parent: this.addModuleQueue,
			processor: this._factorizeModule.bind(this)
		});
		
		this.buildQueue = new AsyncQueue({
			name: "build",
			parent: this.factorizeQueue,
			processor: this._buildModule.bind(this)
		});
		
		this.rebuildQueue = new AsyncQueue({
			name: "rebuild",
			parallelism: options.parallelism || 100,
			processor: this._rebuildModule.bind(this)
		});
 
		this.creatingModuleDuringBuild = new WeakMap();

		
		this.entries = new Map();
		
		this.globalEntry = {
			dependencies: [],
			includeDependencies: [],
			options: {
				name: undefined
			}
		};
		
		this.entrypoints = new Map();
		
		this.asyncEntrypoints = [];
		
		this.chunks = new Set();
		
		this.chunkGroups = [];
		
		this.namedChunkGroups = new Map();
		
		this.namedChunks = new Map();
		
		this.modules = new Set();
		if (this._backCompat) {
			arrayToSetDeprecation(this.chunks, "Compilation.chunks");
			arrayToSetDeprecation(this.modules, "Compilation.modules");
		} 
		this._modules = new Map();
		this.records = null;
		
		this.additionalChunkAssets = [];
		
		this.assets = {};
		
		this.assetsInfo = new Map();
		
		this._assetsRelatedIn = new Map();
		
		this.errors = [];
		
		this.warnings = [];
		
		this.children = [];
		
		this.logging = new Map();
		
		this.dependencyFactories = new Map();
		
		this.dependencyTemplates = new DependencyTemplates(
			this.outputOptions.hashFunction
		);
		
		this.childrenCounters = {};
		
		this.usedChunkIds = null;
		
		this.usedModuleIds = null;
		
		this.needAdditionalPass = false;
		
		this._restoredUnsafeCacheModuleEntries = new Set();
		
		this._restoredUnsafeCacheEntries = new Map();
		
		this.builtModules = new WeakSet();
		
		this.codeGeneratedModules = new WeakSet();
		
		this.buildTimeExecutedModules = new WeakSet(); 
		this._rebuildingModules = new Map();
		
		this.emittedAssets = new Set();
		
		this.comparedForEmitAssets = new Set();
		
		this.fileDependencies = new LazySet();
		
		this.contextDependencies = new LazySet();
		
		this.missingDependencies = new LazySet();
		
		this.buildDependencies = new LazySet();
		// TODO webpack 6 remove
		this.compilationDependencies = {
			add: util.deprecate( 
				item => this.fileDependencies.add(item),
				"Compilation.compilationDependencies is deprecated (used Compilation.fileDependencies instead)",
				"DEP_WEBPACK_COMPILATION_COMPILATION_DEPENDENCIES"
			)
		};

		this._modulesCache = this.getCache("Compilation/modules");
		this._assetsCache = this.getCache("Compilation/assets");
		this._codeGenerationCache = this.getCache("Compilation/codeGeneration");

		const unsafeCache = options.module.unsafeCache;
		this._unsafeCache = Boolean(unsafeCache);
		this._unsafeCachePredicate =
			typeof unsafeCache === "function" ? unsafeCache : () => true;
	}

	getStats() {
		return new Stats(this);
	}
 
	createStatsOptions(optionsOrPreset, context = {}) {
		if (typeof optionsOrPreset === "boolean") {
			optionsOrPreset = {
				preset: optionsOrPreset === false ? "none" : "normal"
			};
		} else if (typeof optionsOrPreset === "string") {
			optionsOrPreset = { preset: optionsOrPreset };
		}
		if (typeof optionsOrPreset === "object" && optionsOrPreset !== null) {
			// We use this method of shallow cloning this object to include
			// properties in the prototype chain
			
			const options = {};
			// eslint-disable-next-line guard-for-in
			for (const key in optionsOrPreset) {
				options[key] = optionsOrPreset[ (key)];
			}
			if (options.preset !== undefined) {
				this.hooks.statsPreset.for(options.preset).call(options, context);
			}
			this.hooks.statsNormalize.call(options, context);
			return  (options);
		}
		
		const options = {};
		this.hooks.statsNormalize.call(options, context);
		return  (options);
	} 
	createStatsFactory(options) {
		const statsFactory = new StatsFactory();
		this.hooks.statsFactory.call(statsFactory, options);
		return statsFactory;
	}
 
	createStatsPrinter(options) {
		const statsPrinter = new StatsPrinter();
		this.hooks.statsPrinter.call(statsPrinter, options);
		return statsPrinter;
	}
 
	getCache(name) {
		return this.compiler.getCache(name);
	}
 
	getLogger(name) {
		if (!name) {
			throw new TypeError("Compilation.getLogger(name) called without a name");
		}
		
		let logEntries;
		return new Logger(
			(type, args) => {
				if (typeof name === "function") {
					name = name();
					if (!name) {
						throw new TypeError(
							"Compilation.getLogger(name) called with a function not returning a name"
						);
					}
				}
				let trace;
				switch (type) {
					case LogType.warn:
					case LogType.error:
					case LogType.trace:
						trace = ErrorHelpers.cutOffLoaderExecution(
							 (new Error("Trace").stack)
						)
							.split("\n")
							.slice(3);
						break;
				}
				
				const logEntry = {
					time: Date.now(),
					type,
					args,
					trace
				};
				if (this.hooks.log.call(name, logEntry) === undefined) {
					if (
						logEntry.type === LogType.profileEnd &&
						typeof console.profileEnd === "function"
					) {
						console.profileEnd(
							`[${name}] ${ (logEntry.args)[0]}`
						);
					}
					if (logEntries === undefined) {
						logEntries = this.logging.get(name);
						if (logEntries === undefined) {
							logEntries = [];
							this.logging.set(name, logEntries);
						}
					}
					logEntries.push(logEntry);
					if (
						logEntry.type === LogType.profile &&
						typeof console.profile === "function"
					) {
						console.profile(
							`[${name}] ${ (logEntry.args)[0]}`
						);
					}
				}
			},
			childName => {
				if (typeof name === "function") {
					if (typeof childName === "function") {
						return this.getLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compilation.getLogger(name) called with a function not returning a name"
									);
								}
							}
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					}
					return this.getLogger(() => {
						if (typeof name === "function") {
							name = name();
							if (!name) {
								throw new TypeError(
									"Compilation.getLogger(name) called with a function not returning a name"
								);
							}
						}
						return `${name}/${childName}`;
					});
				}
				if (typeof childName === "function") {
					return this.getLogger(() => {
						if (typeof childName === "function") {
							childName = childName();
							if (!childName) {
								throw new TypeError(
									"Logger.getChildLogger(name) called with a function not returning a name"
								);
							}
						}
						return `${name}/${childName}`;
					});
				}
				return this.getLogger(`${name}/${childName}`);
			}
		);
	}
 
	addModule(module, callback) {
		this.addModuleQueue.add(module, callback);
	} 
	_addModule(module, callback) {
		const identifier = module.identifier();
		const alreadyAddedModule = this._modules.get(identifier);
		if (alreadyAddedModule) {
			return callback(null, alreadyAddedModule);
		}

		const currentProfile = this.profile
			? this.moduleGraph.getProfile(module)
			: undefined;
		if (currentProfile !== undefined) {
			currentProfile.markRestoringStart();
		}

		this._modulesCache.get(identifier, null, (err, cacheModule) => {
			if (err) return callback(new ModuleRestoreError(module, err));

			if (currentProfile !== undefined) {
				currentProfile.markRestoringEnd();
				currentProfile.markIntegrationStart();
			}

			if (cacheModule) {
				cacheModule.updateCacheModule(module);

				module = cacheModule;
			}
			this._modules.set(identifier, module);
			this.modules.add(module);
			if (this._backCompat)
				ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);
			if (currentProfile !== undefined) {
				currentProfile.markIntegrationEnd();
			}
			callback(null, module);
		});
	}
 
	getModule(module) {
		const identifier = module.identifier();
		return  (this._modules.get(identifier));
	}
 
	findModule(identifier) {
		return this._modules.get(identifier);
	}
 
	buildModule(module, callback) {
		this.buildQueue.add(module, callback);
	} 
	_buildModule(module, callback) {
		const currentProfile = this.profile
			? this.moduleGraph.getProfile(module)
			: undefined;
		if (currentProfile !== undefined) {
			currentProfile.markBuildingStart();
		}

		module.needBuild(
			{
				compilation: this,
				fileSystemInfo: this.fileSystemInfo,
				valueCacheVersions: this.valueCacheVersions
			},
			(err, needBuild) => {
				if (err) return callback(err);

				if (!needBuild) {
					if (currentProfile !== undefined) {
						currentProfile.markBuildingEnd();
					}
					this.hooks.stillValidModule.call(module);
					return callback();
				}

				this.hooks.buildModule.call(module);
				this.builtModules.add(module);
				module.build(
					this.options,
					this,
					this.resolverFactory.get("normal", module.resolveOptions),
					 (this.inputFileSystem),
					err => {
						if (currentProfile !== undefined) {
							currentProfile.markBuildingEnd();
						}
						if (err) {
							this.hooks.failedModule.call(module, err);
							return callback(err);
						}
						if (currentProfile !== undefined) {
							currentProfile.markStoringStart();
						}
						this._modulesCache.store(module.identifier(), null, module, err => {
							if (currentProfile !== undefined) {
								currentProfile.markStoringEnd();
							}
							if (err) {
								this.hooks.failedModule.call(
									module,
									 (err)
								);
								return callback(new ModuleStoreError(module, err));
							}
							this.hooks.succeedModule.call(module);
							return callback();
						});
					}
				);
			}
		);
	}
 
	processModuleDependencies(module, callback) {
		this.processDependenciesQueue.add(module, callback);
	} 
	processModuleDependenciesNonRecursive(module) { 
		const processDependenciesBlock = block => {
			if (block.dependencies) {
				let i = 0;
				for (const dep of block.dependencies) {
					this.moduleGraph.setParents(dep, block, module, i++);
				}
			}
			if (block.blocks) {
				for (const b of block.blocks) processDependenciesBlock(b);
			}
		};

		processDependenciesBlock(module);
	}
 
	_processModuleDependencies(module, callback) {
		
		const sortedDependencies = [];

		
		let currentBlock;

		
		let dependencies;
		
		let factoryCacheKey;
		
		let factoryCacheKey2;
		
		let factoryCacheValue;
		
		let listCacheKey1;
		
		let listCacheKey2;
		
		let listCacheValue;

		let inProgressSorting = 1;
		let inProgressTransitive = 1; 
		const onDependenciesSorted = err => {
			if (err) return callback(err);

			// early exit without changing parallelism back and forth
			if (sortedDependencies.length === 0 && inProgressTransitive === 1) {
				return callback();
			}

			// This is nested so we need to allow one additional task
			this.processDependenciesQueue.increaseParallelism();

			for (const item of sortedDependencies) {
				inProgressTransitive++;
				// eslint-disable-next-line no-loop-func
				this.handleModuleCreation(item, err => {
					// In V8, the Error objects keep a reference to the functions on the stack. These warnings &
					// errors are created inside closures that keep a reference to the Compilation, so errors are
					// leaking the Compilation object.
					if (err && this.bail) {
						if (inProgressTransitive <= 0) return;
						inProgressTransitive = -1;
						// eslint-disable-next-line no-self-assign
						err.stack = err.stack;
						onTransitiveTasksFinished(err);
						return;
					}
					if (--inProgressTransitive === 0) onTransitiveTasksFinished();
				});
			}
			if (--inProgressTransitive === 0) onTransitiveTasksFinished();
		};
 
		const onTransitiveTasksFinished = err => {
			if (err) return callback(err);
			this.processDependenciesQueue.decreaseParallelism();

			return callback();
		};
 
		const processDependency = (dep, index) => {
			this.moduleGraph.setParents(dep, currentBlock, module, index);
			if (this._unsafeCache) {
				try {
					const unsafeCachedModule = unsafeCacheDependencies.get(dep);
					if (unsafeCachedModule === null) return;
					if (unsafeCachedModule !== undefined) {
						if (
							this._restoredUnsafeCacheModuleEntries.has(unsafeCachedModule)
						) {
							this._handleExistingModuleFromUnsafeCache(
								module,
								dep,
								unsafeCachedModule
							);
							return;
						}
						const identifier = unsafeCachedModule.identifier();
						const cachedModule =
							this._restoredUnsafeCacheEntries.get(identifier);
						if (cachedModule !== undefined) {
							// update unsafe cache to new module
							unsafeCacheDependencies.set(dep, cachedModule);
							this._handleExistingModuleFromUnsafeCache(
								module,
								dep,
								cachedModule
							);
							return;
						}
						inProgressSorting++;
						this._modulesCache.get(identifier, null, (err, cachedModule) => {
							if (err) {
								if (inProgressSorting <= 0) return;
								inProgressSorting = -1;
								onDependenciesSorted( (err));
								return;
							}
							try {
								if (!this._restoredUnsafeCacheEntries.has(identifier)) {
									const data = unsafeCacheData.get(cachedModule);
									if (data === undefined) {
										processDependencyForResolving(dep);
										if (--inProgressSorting === 0) onDependenciesSorted();
										return;
									}
									if (cachedModule !== unsafeCachedModule) {
										unsafeCacheDependencies.set(dep, cachedModule);
									}
									cachedModule.restoreFromUnsafeCache(
										data,
										this.params.normalModuleFactory,
										this.params
									);
									this._restoredUnsafeCacheEntries.set(
										identifier,
										cachedModule
									);
									this._restoredUnsafeCacheModuleEntries.add(cachedModule);
									if (!this.modules.has(cachedModule)) {
										inProgressTransitive++;
										this._handleNewModuleFromUnsafeCache(
											module,
											dep,
											cachedModule,
											err => {
												if (err) {
													if (inProgressTransitive <= 0) return;
													inProgressTransitive = -1;
													onTransitiveTasksFinished(err);
												}
												if (--inProgressTransitive === 0)
													return onTransitiveTasksFinished();
											}
										);
										if (--inProgressSorting === 0) onDependenciesSorted();
										return;
									}
								}
								if (unsafeCachedModule !== cachedModule) {
									unsafeCacheDependencies.set(dep, cachedModule);
								}
								this._handleExistingModuleFromUnsafeCache(
									module,
									dep,
									cachedModule
								); // a3
							} catch (err) {
								if (inProgressSorting <= 0) return;
								inProgressSorting = -1;
								onDependenciesSorted( (err));
								return;
							}
							if (--inProgressSorting === 0) onDependenciesSorted();
						});
						return;
					}
				} catch (err) {
					console.error(err);
				}
			}
			processDependencyForResolving(dep);
		};
 
		const processDependencyForResolving = dep => {
			const resourceIdent = dep.getResourceIdentifier();
			if (resourceIdent !== undefined && resourceIdent !== null) {
				const category = dep.category;
				const constructor =  (dep.constructor);
				if (factoryCacheKey === constructor) {
					// Fast path 1: same constructor as prev item
					if (listCacheKey1 === category && listCacheKey2 === resourceIdent) {
						// Super fast path 1: also same resource
						listCacheValue.push(dep);
						return;
					}
				} else {
					const factory = this.dependencyFactories.get(constructor);
					if (factory === undefined) {
						throw new Error(
							`No module factory available for dependency type: ${constructor.name}`
						);
					}
					if (factoryCacheKey2 === factory) {
						// Fast path 2: same factory as prev item
						factoryCacheKey = constructor;
						if (listCacheKey1 === category && listCacheKey2 === resourceIdent) {
							// Super fast path 2: also same resource
							listCacheValue.push(dep);
							return;
						}
					} else {
						// Slow path
						if (factoryCacheKey2 !== undefined) {
							// Archive last cache entry
							if (dependencies === undefined) dependencies = new Map();
							dependencies.set(factoryCacheKey2, factoryCacheValue);
							factoryCacheValue = dependencies.get(factory);
							if (factoryCacheValue === undefined) {
								factoryCacheValue = new Map();
							}
						} else {
							factoryCacheValue = new Map();
						}
						factoryCacheKey = constructor;
						factoryCacheKey2 = factory;
					}
				}
				// Here webpack is using heuristic that assumes
				// mostly esm dependencies would be used
				// so we don't allocate extra string for them
				const cacheKey =
					category === esmDependencyCategory
						? resourceIdent
						: `${category}${resourceIdent}`;
				let list = factoryCacheValue.get(cacheKey);
				if (list === undefined) {
					factoryCacheValue.set(cacheKey, (list = []));
					sortedDependencies.push({
						factory: factoryCacheKey2,
						dependencies: list,
						context: dep.getContext(),
						originModule: module
					});
				}
				list.push(dep);
				listCacheKey1 = category;
				listCacheKey2 = resourceIdent;
				listCacheValue = list;
			}
		};

		try {
			
			const queue = [module];
			do {
				const block =  (queue.pop());
				if (block.dependencies) {
					currentBlock = block;
					let i = 0;
					for (const dep of block.dependencies) processDependency(dep, i++);
				}
				if (block.blocks) {
					for (const b of block.blocks) queue.push(b);
				}
			} while (queue.length !== 0);
		} catch (err) {
			return callback(err);
		}

		if (--inProgressSorting === 0) onDependenciesSorted();
	}
 
	_handleNewModuleFromUnsafeCache(originModule, dependency, module, callback) {
		const moduleGraph = this.moduleGraph;

		moduleGraph.setResolvedModule(originModule, dependency, module);

		moduleGraph.setIssuerIfUnset(
			module,
			originModule !== undefined ? originModule : null
		);

		this._modules.set(module.identifier(), module);
		this.modules.add(module);
		if (this._backCompat)
			ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);

		this._handleModuleBuildAndDependencies(
			originModule,
			module,
			true,
			false,
			callback
		);
	}
 
	_handleExistingModuleFromUnsafeCache(originModule, dependency, module) {
		const moduleGraph = this.moduleGraph;

		moduleGraph.setResolvedModule(originModule, dependency, module);
	}
  
	handleModuleCreation(
		{
			factory,
			dependencies,
			originModule,
			contextInfo,
			context,
			recursive = true,
			connectOrigin = recursive,
			checkCycle = !recursive
		},
		callback
	) {
		const moduleGraph = this.moduleGraph;

		const currentProfile = this.profile ? new ModuleProfile() : undefined;

		this.factorizeModule(
			{
				currentProfile,
				factory,
				dependencies,
				factoryResult: true,
				originModule,
				contextInfo,
				context
			},
			(err, factoryResult) => {
				const applyFactoryResultDependencies = () => {
					const { fileDependencies, contextDependencies, missingDependencies } =
						factoryResult;
					if (fileDependencies) {
						this.fileDependencies.addAll(fileDependencies);
					}
					if (contextDependencies) {
						this.contextDependencies.addAll(contextDependencies);
					}
					if (missingDependencies) {
						this.missingDependencies.addAll(missingDependencies);
					}
				};
				if (err) {
					if (factoryResult) applyFactoryResultDependencies();
					if (dependencies.every(d => d.optional)) {
						this.warnings.push(err);
						return callback();
					}
					this.errors.push(err);
					return callback(err);
				}

				const newModule = factoryResult.module;

				if (!newModule) {
					applyFactoryResultDependencies();
					return callback();
				}

				if (currentProfile !== undefined) {
					moduleGraph.setProfile(newModule, currentProfile);
				}

				this.addModule(newModule, (err, _module) => {
					if (err) {
						applyFactoryResultDependencies();
						if (!err.module) {
							err.module = _module;
						}
						this.errors.push(err);

						return callback(err);
					}

					const module =
						
						(_module);

					if (
						this._unsafeCache &&
						factoryResult.cacheable !== false &&
						module.restoreFromUnsafeCache &&
						this._unsafeCachePredicate(module)
					) {
						const unsafeCacheableModule =
							
							(module);
						for (let i = 0; i < dependencies.length; i++) {
							const dependency = dependencies[i];
							moduleGraph.setResolvedModule(
								connectOrigin ? originModule : null,
								dependency,
								unsafeCacheableModule
							);
							unsafeCacheDependencies.set(dependency, unsafeCacheableModule);
						}
						if (!unsafeCacheData.has(unsafeCacheableModule)) {
							unsafeCacheData.set(
								unsafeCacheableModule,
								unsafeCacheableModule.getUnsafeCacheData()
							);
						}
					} else {
						applyFactoryResultDependencies();
						for (let i = 0; i < dependencies.length; i++) {
							const dependency = dependencies[i];
							moduleGraph.setResolvedModule(
								connectOrigin ? originModule : null,
								dependency,
								module
							);
						}
					}

					moduleGraph.setIssuerIfUnset(
						module,
						originModule !== undefined ? originModule : null
					);
					if (module !== newModule && currentProfile !== undefined) {
						const otherProfile = moduleGraph.getProfile(module);
						if (otherProfile !== undefined) {
							currentProfile.mergeInto(otherProfile);
						} else {
							moduleGraph.setProfile(module, currentProfile);
						}
					}

					this._handleModuleBuildAndDependencies(
						originModule,
						module,
						recursive,
						checkCycle,
						callback
					);
				});
			}
		);
	} 
	_handleModuleBuildAndDependencies(
		originModule,
		module,
		recursive,
		checkCycle,
		callback
	) {
		// Check for cycles when build is trigger inside another build
		
		let creatingModuleDuringBuildSet;
		if (checkCycle && this.buildQueue.isProcessing(originModule)) {
			// Track build dependency
			creatingModuleDuringBuildSet =
				this.creatingModuleDuringBuild.get(originModule);
			if (creatingModuleDuringBuildSet === undefined) {
				creatingModuleDuringBuildSet = new Set();
				this.creatingModuleDuringBuild.set(
					originModule,
					creatingModuleDuringBuildSet
				);
			}
			creatingModuleDuringBuildSet.add(module);

			// When building is blocked by another module
			// search for a cycle, cancel the cycle by throwing
			// an error (otherwise this would deadlock)
			const blockReasons = this.creatingModuleDuringBuild.get(module);
			if (blockReasons !== undefined) {
				const set = new Set(blockReasons);
				for (const item of set) {
					const blockReasons = this.creatingModuleDuringBuild.get(item);
					if (blockReasons !== undefined) {
						for (const m of blockReasons) {
							if (m === module) {
								return callback(new BuildCycleError(module));
							}
							set.add(m);
						}
					}
				}
			}
		}

		this.buildModule(module, err => {
			if (creatingModuleDuringBuildSet !== undefined) {
				creatingModuleDuringBuildSet.delete(module);
			}
			if (err) {
				if (!err.module) {
					err.module = module;
				}
				this.errors.push(err);

				return callback(err);
			}

			if (!recursive) {
				this.processModuleDependenciesNonRecursive(module);
				callback(null, module);
				return;
			}

			// This avoids deadlocks for circular dependencies
			if (this.processDependenciesQueue.isProcessing(module)) {
				return callback(null, module);
			}

			this.processModuleDependencies(module, err => {
				if (err) {
					return callback(err);
				}
				callback(null, module);
			});
		});
	}

	 
	_factorizeModule(
		{
			currentProfile,
			factory,
			dependencies,
			originModule,
			factoryResult,
			contextInfo,
			context
		},
		callback
	) {
		if (currentProfile !== undefined) {
			currentProfile.markFactoryStart();
		}
		factory.create(
			{
				contextInfo: {
					issuer: originModule ? originModule.nameForCondition() : "",
					issuerLayer: originModule ? originModule.layer : null,
					compiler: this.compiler.name,
					...contextInfo
				},
				resolveOptions: originModule ? originModule.resolveOptions : undefined,
				context:
					context ||
					(originModule ? originModule.context : this.compiler.context),
				dependencies
			},
			(err, result) => {
				if (result) {
					// TODO webpack 6: remove
					// For backward-compat
					if (result.module === undefined && result instanceof Module) {
						result = {
							module: result
						};
					}
					if (!factoryResult) {
						const {
							fileDependencies,
							contextDependencies,
							missingDependencies
						} = result;
						if (fileDependencies) {
							this.fileDependencies.addAll(fileDependencies);
						}
						if (contextDependencies) {
							this.contextDependencies.addAll(contextDependencies);
						}
						if (missingDependencies) {
							this.missingDependencies.addAll(missingDependencies);
						}
					}
				}
				if (err) {
					const notFoundError = new ModuleNotFoundError(
						originModule,
						err,
						dependencies.map(d => d.loc).find(Boolean)
					);
					return callback(notFoundError, factoryResult ? result : undefined);
				}
				if (!result) {
					return callback();
				}

				if (currentProfile !== undefined) {
					currentProfile.markFactoryEnd();
				}

				callback(null, factoryResult ? result : result.module);
			}
		);
	}
 
	addModuleChain(context, dependency, callback) {
		// @ts-ignore
		return this.addModuleTree({ context, dependency }, callback);
	} 
	addModuleTree({ context, dependency, contextInfo }, callback) {
		if (
			typeof dependency !== "object" ||
			dependency === null ||
			!dependency.constructor
		) {
			return callback(
				new WebpackError("Parameter 'dependency' must be a Dependency")
			);
		}
		const Dep =  (dependency.constructor);
		const moduleFactory = this.dependencyFactories.get(Dep);
		if (!moduleFactory) {
			return callback(
				new WebpackError(
					`No dependency factory available for this dependency type: ${dependency.constructor.name}`
				)
			);
		}

		this.handleModuleCreation(
			{
				factory: moduleFactory,
				dependencies: [dependency],
				originModule: null,
				contextInfo,
				context
			},
			(err, result) => {
				if (err && this.bail) {
					callback(err);
					this.buildQueue.stop();
					this.rebuildQueue.stop();
					this.processDependenciesQueue.stop();
					this.factorizeQueue.stop();
				} else if (!err && result) {
					callback(null, result);
				} else {
					callback();
				}
			}
		);
	}

 
	addEntry(context, entry, optionsOrName, callback) {
		// TODO webpack 6 remove
		const options =
			typeof optionsOrName === "object"
				? optionsOrName
				: { name: optionsOrName };

		this._addEntryItem(context, entry, "dependencies", options, callback);
	}

 
	addInclude(context, dependency, options, callback) {
		this._addEntryItem(
			context,
			dependency,
			"includeDependencies",
			options,
			callback
		);
	}
 
	_addEntryItem(context, entry, target, options, callback) {
		const { name } = options;
		let entryData =
			name !== undefined ? this.entries.get(name) : this.globalEntry;
		if (entryData === undefined) {
			entryData = {
				dependencies: [],
				includeDependencies: [],
				options: {
					name: undefined,
					...options
				}
			};
			entryData[target].push(entry);
			this.entries.set(
				 (name),
				entryData
			);
		} else {
			entryData[target].push(entry);
			for (const key of Object.keys(options)) {
				if (options[key] === undefined) continue;
				if (entryData.options[key] === options[key]) continue;
				if (
					Array.isArray(entryData.options[key]) &&
					Array.isArray(options[key]) &&
					arrayEquals(entryData.options[key], options[key])
				) {
					continue;
				}
				if (entryData.options[key] === undefined) {
					entryData.options[key] = options[key];
				} else {
					return callback(
						new WebpackError(
							`Conflicting entry option ${key} = ${entryData.options[key]} vs ${options[key]}`
						)
					);
				}
			}
		}

		this.hooks.addEntry.call(entry, options);

		this.addModuleTree(
			{
				context,
				dependency: entry,
				contextInfo: entryData.options.layer
					? { issuerLayer: entryData.options.layer }
					: undefined
			},
			(err, module) => {
				if (err) {
					this.hooks.failedEntry.call(entry, options, err);
					return callback(err);
				}
				this.hooks.succeedEntry.call(
					entry,
					options,
					 (module)
				);
				return callback(null, module);
			}
		);
	}

	 
	rebuildModule(module, callback) {
		this.rebuildQueue.add(module, callback);
	}
 
	_rebuildModule(module, callback) {
		this.hooks.rebuildModule.call(module);
		const oldDependencies = module.dependencies.slice();
		const oldBlocks = module.blocks.slice();
		module.invalidateBuild();
		this.buildQueue.invalidate(module);
		this.buildModule(module, err => {
			if (err) {
				return this.hooks.finishRebuildingModule.callAsync(module, err2 => {
					if (err2) {
						callback(
							makeWebpackError(err2, "Compilation.hooks.finishRebuildingModule")
						);
						return;
					}
					callback(err);
				});
			}

			this.processDependenciesQueue.invalidate(module);
			this.moduleGraph.unfreeze();
			this.processModuleDependencies(module, err => {
				if (err) return callback(err);
				this.removeReasonsOfDependencyBlock(module, {
					dependencies: oldDependencies,
					blocks: oldBlocks
				});
				this.hooks.finishRebuildingModule.callAsync(module, err2 => {
					if (err2) {
						callback(
							makeWebpackError(err2, "Compilation.hooks.finishRebuildingModule")
						);
						return;
					}
					callback(null, module);
				});
			});
		});
	}
 
	_computeAffectedModules(modules) {
		const moduleMemCacheCache = this.compiler.moduleMemCaches;
		if (!moduleMemCacheCache) return;
		if (!this.moduleMemCaches) {
			this.moduleMemCaches = new Map();
			this.moduleGraph.setModuleMemCaches(this.moduleMemCaches);
		}
		const { moduleGraph, moduleMemCaches } = this;
		const affectedModules = new Set();
		const infectedModules = new Set();
		let statNew = 0;
		let statChanged = 0;
		let statUnchanged = 0;
		let statReferencesChanged = 0;
		let statWithoutBuild = 0;

		 
		const computeReferences = module => {
			
			let references;
			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const d = connection.dependency;
				const m = connection.module;
				if (!d || !m || unsafeCacheDependencies.has(d)) continue;
				if (references === undefined) references = new WeakMap();
				references.set(d, m);
			}
			return references;
		};

	 
		const compareReferences = (module, references) => {
			if (references === undefined) return true;
			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const d = connection.dependency;
				if (!d) continue;
				const entry = references.get(d);
				if (entry === undefined) continue;
				if (entry !== connection.module) return false;
			}
			return true;
		};

		const modulesWithoutCache = new Set(modules);
		for (const [module, cachedMemCache] of moduleMemCacheCache) {
			if (modulesWithoutCache.has(module)) {
				const buildInfo = module.buildInfo;
				if (buildInfo) {
					if (cachedMemCache.buildInfo !== buildInfo) {
						// use a new one
						const memCache = new WeakTupleMap();
						moduleMemCaches.set(module, memCache);
						affectedModules.add(module);
						cachedMemCache.buildInfo = buildInfo;
						cachedMemCache.references = computeReferences(module);
						cachedMemCache.memCache = memCache;
						statChanged++;
					} else if (!compareReferences(module, cachedMemCache.references)) {
						// use a new one
						const memCache = new WeakTupleMap();
						moduleMemCaches.set(module, memCache);
						affectedModules.add(module);
						cachedMemCache.references = computeReferences(module);
						cachedMemCache.memCache = memCache;
						statReferencesChanged++;
					} else {
						// keep the old mem cache
						moduleMemCaches.set(module, cachedMemCache.memCache);
						statUnchanged++;
					}
				} else {
					infectedModules.add(module);
					moduleMemCacheCache.delete(module);
					statWithoutBuild++;
				}
				modulesWithoutCache.delete(module);
			} else {
				moduleMemCacheCache.delete(module);
			}
		}

		for (const module of modulesWithoutCache) {
			const buildInfo = module.buildInfo;
			if (buildInfo) {
				// create a new entry
				const memCache = new WeakTupleMap();
				moduleMemCacheCache.set(module, {
					buildInfo,
					references: computeReferences(module),
					memCache
				});
				moduleMemCaches.set(module, memCache);
				affectedModules.add(module);
				statNew++;
			} else {
				infectedModules.add(module);
				statWithoutBuild++;
			}
		}
 
		const reduceAffectType = connections => {
			let affected = false;
			for (const { dependency } of connections) {
				if (!dependency) continue;
				const type = dependency.couldAffectReferencingModule();
				if (type === Dependency.TRANSITIVE) return Dependency.TRANSITIVE;
				if (type === false) continue;
				affected = true;
			}
			return affected;
		};
		const directOnlyInfectedModules = new Set();
		for (const module of infectedModules) {
			for (const [
				referencingModule,
				connections
			] of moduleGraph.getIncomingConnectionsByOriginModule(module)) {
				if (!referencingModule) continue;
				if (infectedModules.has(referencingModule)) continue;
				const type = reduceAffectType(connections);
				if (!type) continue;
				if (type === true) {
					directOnlyInfectedModules.add(referencingModule);
				} else {
					infectedModules.add(referencingModule);
				}
			}
		}
		for (const module of directOnlyInfectedModules) infectedModules.add(module);
		const directOnlyAffectModules = new Set();
		for (const module of affectedModules) {
			for (const [
				referencingModule,
				connections
			] of moduleGraph.getIncomingConnectionsByOriginModule(module)) {
				if (!referencingModule) continue;
				if (infectedModules.has(referencingModule)) continue;
				if (affectedModules.has(referencingModule)) continue;
				const type = reduceAffectType(connections);
				if (!type) continue;
				if (type === true) {
					directOnlyAffectModules.add(referencingModule);
				} else {
					affectedModules.add(referencingModule);
				}
				const memCache = new WeakTupleMap();
				const cache = moduleMemCacheCache.get(referencingModule);
				cache.memCache = memCache;
				moduleMemCaches.set(referencingModule, memCache);
			}
		}
		for (const module of directOnlyAffectModules) affectedModules.add(module);
		this.logger.log(
			`${Math.round(
				(100 * (affectedModules.size + infectedModules.size)) /
					this.modules.size
			)}% (${affectedModules.size} affected + ${
				infectedModules.size
			} infected of ${
				this.modules.size
			}) modules flagged as affected (${statNew} new modules, ${statChanged} changed, ${statReferencesChanged} references changed, ${statUnchanged} unchanged, ${statWithoutBuild} were not built)`
		);
	}

	_computeAffectedModulesWithChunkGraph() {
		const { moduleMemCaches } = this;
		if (!moduleMemCaches) return;
		const moduleMemCaches2 = (this.moduleMemCaches2 = new Map());
		const { moduleGraph, chunkGraph } = this;
		const key = "memCache2";
		let statUnchanged = 0;
		let statChanged = 0;
		let statNew = 0; 
		const computeReferences = module => {
			const id = chunkGraph.getModuleId(module);
			
			let modules;
			
			let blocks;
			const outgoing = moduleGraph.getOutgoingConnectionsByModule(module);
			if (outgoing !== undefined) {
				for (const m of outgoing.keys()) {
					if (!m) continue;
					if (modules === undefined) modules = new Map();
					modules.set(m, chunkGraph.getModuleId(m));
				}
			}
			if (module.blocks.length > 0) {
				blocks = [];
				const queue = Array.from(module.blocks);
				for (const block of queue) {
					const chunkGroup = chunkGraph.getBlockChunkGroup(block);
					if (chunkGroup) {
						for (const chunk of chunkGroup.chunks) {
							blocks.push(chunk.id);
						}
					} else {
						blocks.push(null);
					}
					// eslint-disable-next-line prefer-spread
					queue.push.apply(queue, block.blocks);
				}
			}
			return { id, modules, blocks };
		}; 
		const compareReferences = (module, { id, modules, blocks }) => {
			if (id !== chunkGraph.getModuleId(module)) return false;
			if (modules !== undefined) {
				for (const [module, id] of modules) {
					if (chunkGraph.getModuleId(module) !== id) return false;
				}
			}
			if (blocks !== undefined) {
				const queue = Array.from(module.blocks);
				let i = 0;
				for (const block of queue) {
					const chunkGroup = chunkGraph.getBlockChunkGroup(block);
					if (chunkGroup) {
						for (const chunk of chunkGroup.chunks) {
							if (i >= blocks.length || blocks[i++] !== chunk.id) return false;
						}
					} else if (i >= blocks.length || blocks[i++] !== null) {
						return false;
					}
					// eslint-disable-next-line prefer-spread
					queue.push.apply(queue, block.blocks);
				}
				if (i !== blocks.length) return false;
			}
			return true;
		};

		for (const [module, memCache] of moduleMemCaches) {
			
			const cache = memCache.get(key);
			if (cache === undefined) {
				const memCache2 = new WeakTupleMap();
				memCache.set(key, {
					references: computeReferences(module),
					memCache: memCache2
				});
				moduleMemCaches2.set(module, memCache2);
				statNew++;
			} else if (!compareReferences(module, cache.references)) {
				const memCache = new WeakTupleMap();
				cache.references = computeReferences(module);
				cache.memCache = memCache;
				moduleMemCaches2.set(module, memCache);
				statChanged++;
			} else {
				moduleMemCaches2.set(module, cache.memCache);
				statUnchanged++;
			}
		}

		this.logger.log(
			`${Math.round(
				(100 * statChanged) / (statNew + statChanged + statUnchanged)
			)}% modules flagged as affected by chunk graph (${statNew} new modules, ${statChanged} changed, ${statUnchanged} unchanged)`
		);
	}
 
	finish(callback) {
		this.factorizeQueue.clear();
		if (this.profile) {
			this.logger.time("finish module profiles");
			const ParallelismFactorCalculator = require("./util/ParallelismFactorCalculator");
			const p = new ParallelismFactorCalculator();
			const moduleGraph = this.moduleGraph;
			
			const modulesWithProfiles = new Map();
			for (const module of this.modules) {
				const profile = moduleGraph.getProfile(module);
				if (!profile) continue;
				modulesWithProfiles.set(module, profile);
				p.range(
					profile.buildingStartTime,
					profile.buildingEndTime,
					f => (profile.buildingParallelismFactor = f)
				);
				p.range(
					profile.factoryStartTime,
					profile.factoryEndTime,
					f => (profile.factoryParallelismFactor = f)
				);
				p.range(
					profile.integrationStartTime,
					profile.integrationEndTime,
					f => (profile.integrationParallelismFactor = f)
				);
				p.range(
					profile.storingStartTime,
					profile.storingEndTime,
					f => (profile.storingParallelismFactor = f)
				);
				p.range(
					profile.restoringStartTime,
					profile.restoringEndTime,
					f => (profile.restoringParallelismFactor = f)
				);
				if (profile.additionalFactoryTimes) {
					for (const { start, end } of profile.additionalFactoryTimes) {
						const influence = (end - start) / profile.additionalFactories;
						p.range(
							start,
							end,
							f =>
								(profile.additionalFactoriesParallelismFactor += f * influence)
						);
					}
				}
			}
			p.calculate();

			const logger = this.getLogger("webpack.Compilation.ModuleProfile");
			// Avoid coverage problems due indirect changes
			/* istanbul ignore next */
			const logByValue = (value, msg) => {
				if (value > 1000) {
					logger.error(msg);
				} else if (value > 500) {
					logger.warn(msg);
				} else if (value > 200) {
					logger.info(msg);
				} else if (value > 30) {
					logger.log(msg);
				} else {
					logger.debug(msg);
				}
			};
			 
			const logNormalSummary = (category, getDuration, getParallelism) => {
				let sum = 0;
				let max = 0;
				for (const [module, profile] of modulesWithProfiles) {
					const p = getParallelism(profile);
					const d = getDuration(profile);
					if (d === 0 || p === 0) continue;
					const t = d / p;
					sum += t;
					if (t <= 10) continue;
					logByValue(
						t,
						` | ${Math.round(t)} ms${
							p >= 1.1 ? ` (parallelism ${Math.round(p * 10) / 10})` : ""
						} ${category} > ${module.readableIdentifier(this.requestShortener)}`
					);
					max = Math.max(max, t);
				}
				if (sum <= 10) return;
				logByValue(
					Math.max(sum / 10, max),
					`${Math.round(sum)} ms ${category}`
				);
			}; 
			const logByLoadersSummary = (category, getDuration, getParallelism) => {
				const map = new Map();
				for (const [module, profile] of modulesWithProfiles) {
					const list = getOrInsert(
						map,
						`${module.type}!${module.identifier().replace(/(!|^)[^!]*$/, "")}`,
						() => []
					);
					list.push({ module, profile });
				}

				let sum = 0;
				let max = 0;
				for (const [key, modules] of map) {
					let innerSum = 0;
					let innerMax = 0;
					for (const { module, profile } of modules) {
						const p = getParallelism(profile);
						const d = getDuration(profile);
						if (d === 0 || p === 0) continue;
						const t = d / p;
						innerSum += t;
						if (t <= 10) continue;
						logByValue(
							t,
							` |  | ${Math.round(t)} ms${
								p >= 1.1 ? ` (parallelism ${Math.round(p * 10) / 10})` : ""
							} ${category} > ${module.readableIdentifier(
								this.requestShortener
							)}`
						);
						innerMax = Math.max(innerMax, t);
					}
					sum += innerSum;
					if (innerSum <= 10) continue;
					const idx = key.indexOf("!");
					const loaders = key.slice(idx + 1);
					const moduleType = key.slice(0, idx);
					const t = Math.max(innerSum / 10, innerMax);
					logByValue(
						t,
						` | ${Math.round(innerSum)} ms ${category} > ${
							loaders
								? `${
										modules.length
									} x ${moduleType} with ${this.requestShortener.shorten(
										loaders
									)}`
								: `${modules.length} x ${moduleType}`
						}`
					);
					max = Math.max(max, t);
				}
				if (sum <= 10) return;
				logByValue(
					Math.max(sum / 10, max),
					`${Math.round(sum)} ms ${category}`
				);
			};
			logNormalSummary(
				"resolve to new modules",
				p => p.factory,
				p => p.factoryParallelismFactor
			);
			logNormalSummary(
				"resolve to existing modules",
				p => p.additionalFactories,
				p => p.additionalFactoriesParallelismFactor
			);
			logNormalSummary(
				"integrate modules",
				p => p.restoring,
				p => p.restoringParallelismFactor
			);
			logByLoadersSummary(
				"build modules",
				p => p.building,
				p => p.buildingParallelismFactor
			);
			logNormalSummary(
				"store modules",
				p => p.storing,
				p => p.storingParallelismFactor
			);
			logNormalSummary(
				"restore modules",
				p => p.restoring,
				p => p.restoringParallelismFactor
			);
			this.logger.timeEnd("finish module profiles");
		}
		this.logger.time("compute affected modules");
		this._computeAffectedModules(this.modules);
		this.logger.timeEnd("compute affected modules");
		this.logger.time("finish modules");
		const { modules, moduleMemCaches } = this;
		this.hooks.finishModules.callAsync(modules, err => {
			this.logger.timeEnd("finish modules");
			if (err) return callback( (err));

			// extract warnings and errors from modules
			this.moduleGraph.freeze("dependency errors");
			// TODO keep a cacheToken (= {}) for each module in the graph
			// create a new one per compilation and flag all updated files
			// and parents with it
			this.logger.time("report dependency errors and warnings");
			for (const module of modules) {
				// TODO only run for modules with changed cacheToken
				// global WeakMap<CacheToken, WeakSet<Module>> to keep modules without errors/warnings
				const memCache = moduleMemCaches && moduleMemCaches.get(module);
				if (memCache && memCache.get("noWarningsOrErrors")) continue;
				let hasProblems = this.reportDependencyErrorsAndWarnings(module, [
					module
				]);
				const errors = module.getErrors();
				if (errors !== undefined) {
					for (const error of errors) {
						if (!error.module) {
							error.module = module;
						}
						this.errors.push(error);
						hasProblems = true;
					}
				}
				const warnings = module.getWarnings();
				if (warnings !== undefined) {
					for (const warning of warnings) {
						if (!warning.module) {
							warning.module = module;
						}
						this.warnings.push(warning);
						hasProblems = true;
					}
				}
				if (!hasProblems && memCache) memCache.set("noWarningsOrErrors", true);
			}
			this.moduleGraph.unfreeze();
			this.logger.timeEnd("report dependency errors and warnings");

			callback();
		});
	}

	unseal() {
		this.hooks.unseal.call();
		this.chunks.clear();
		this.chunkGroups.length = 0;
		this.namedChunks.clear();
		this.namedChunkGroups.clear();
		this.entrypoints.clear();
		this.additionalChunkAssets.length = 0;
		this.assets = {};
		this.assetsInfo.clear();
		this.moduleGraph.removeAllModuleAttributes();
		this.moduleGraph.unfreeze();
		this.moduleMemCaches2 = undefined;
	}
 
	seal(callback) { 
		const finalCallback = err => {
			this.factorizeQueue.clear();
			this.buildQueue.clear();
			this.rebuildQueue.clear();
			this.processDependenciesQueue.clear();
			this.addModuleQueue.clear();
			return callback(err);
		};
		const chunkGraph = new ChunkGraph(
			this.moduleGraph,
			this.outputOptions.hashFunction
		);
		this.chunkGraph = chunkGraph;

		if (this._backCompat) {
			for (const module of this.modules) {
				ChunkGraph.setChunkGraphForModule(module, chunkGraph);
			}
		}

		this.hooks.seal.call();

		this.logger.time("optimize dependencies");
		while (this.hooks.optimizeDependencies.call(this.modules)) {
			/* empty */
		}
		this.hooks.afterOptimizeDependencies.call(this.modules);
		this.logger.timeEnd("optimize dependencies");

		this.logger.time("create chunks");
		this.hooks.beforeChunks.call();
		this.moduleGraph.freeze("seal");
		
		const chunkGraphInit = new Map();
		for (const [name, { dependencies, includeDependencies, options }] of this
			.entries) {
			const chunk = this.addChunk(name);
			if (options.filename) {
				chunk.filenameTemplate = options.filename;
			}
			const entrypoint = new Entrypoint(options);
			if (!options.dependOn && !options.runtime) {
				entrypoint.setRuntimeChunk(chunk);
			}
			entrypoint.setEntrypointChunk(chunk);
			this.namedChunkGroups.set(name, entrypoint);
			this.entrypoints.set(name, entrypoint);
			this.chunkGroups.push(entrypoint);
			connectChunkGroupAndChunk(entrypoint, chunk);

			const entryModules = new Set();
			for (const dep of [...this.globalEntry.dependencies, ...dependencies]) {
				entrypoint.addOrigin(null, { name },  (dep).request);

				const module = this.moduleGraph.getModule(dep);
				if (module) {
					chunkGraph.connectChunkAndEntryModule(chunk, module, entrypoint);
					entryModules.add(module);
					const modulesList = chunkGraphInit.get(entrypoint);
					if (modulesList === undefined) {
						chunkGraphInit.set(entrypoint, [module]);
					} else {
						modulesList.push(module);
					}
				}
			}

			this.assignDepths(entryModules);

			 
			const mapAndSort = deps =>
				
				(deps.map(dep => this.moduleGraph.getModule(dep)).filter(Boolean)).sort(
					compareModulesByIdentifier
				);
			const includedModules = [
				...mapAndSort(this.globalEntry.includeDependencies),
				...mapAndSort(includeDependencies)
			];

			let modulesList = chunkGraphInit.get(entrypoint);
			if (modulesList === undefined) {
				chunkGraphInit.set(entrypoint, (modulesList = []));
			}
			for (const module of includedModules) {
				this.assignDepth(module);
				modulesList.push(module);
			}
		}
		const runtimeChunks = new Set();
		outer: for (const [
			name,
			{
				options: { dependOn, runtime }
			}
		] of this.entries) {
			if (dependOn && runtime) {
				const err =
					new WebpackError(`Entrypoint '${name}' has 'dependOn' and 'runtime' specified. This is not valid.
Entrypoints that depend on other entrypoints do not have their own runtime.
They will use the runtime(s) from referenced entrypoints instead.
Remove the 'runtime' option from the entrypoint.`);
				const entry =  (this.entrypoints.get(name));
				err.chunk = entry.getEntrypointChunk();
				this.errors.push(err);
			}
			if (dependOn) {
				const entry =  (this.entrypoints.get(name));
				const referencedChunks = entry
					.getEntrypointChunk()
					.getAllReferencedChunks();
				const dependOnEntries = [];
				for (const dep of dependOn) {
					const dependency = this.entrypoints.get(dep);
					if (!dependency) {
						throw new Error(
							`Entry ${name} depends on ${dep}, but this entry was not found`
						);
					}
					if (referencedChunks.has(dependency.getEntrypointChunk())) {
						const err = new WebpackError(
							`Entrypoints '${name}' and '${dep}' use 'dependOn' to depend on each other in a circular way.`
						);
						const entryChunk = entry.getEntrypointChunk();
						err.chunk = entryChunk;
						this.errors.push(err);
						entry.setRuntimeChunk(entryChunk);
						continue outer;
					}
					dependOnEntries.push(dependency);
				}
				for (const dependency of dependOnEntries) {
					connectChunkGroupParentAndChild(dependency, entry);
				}
			} else if (runtime) {
				const entry =  (this.entrypoints.get(name));
				let chunk = this.namedChunks.get(runtime);
				if (chunk) {
					if (!runtimeChunks.has(chunk)) {
						const err =
							new WebpackError(`Entrypoint '${name}' has a 'runtime' option which points to another entrypoint named '${runtime}'.
It's not valid to use other entrypoints as runtime chunk.
Did you mean to use 'dependOn: ${JSON.stringify(
								runtime
							)}' instead to allow using entrypoint '${name}' within the runtime of entrypoint '${runtime}'? For this '${runtime}' must always be loaded when '${name}' is used.
Or do you want to use the entrypoints '${name}' and '${runtime}' independently on the same page with a shared runtime? In this case give them both the same value for the 'runtime' option. It must be a name not already used by an entrypoint.`);
						const entryChunk =
							
							(entry.getEntrypointChunk());
						err.chunk = entryChunk;
						this.errors.push(err);
						entry.setRuntimeChunk(entryChunk);
						continue;
					}
				} else {
					chunk = this.addChunk(runtime);
					chunk.preventIntegration = true;
					runtimeChunks.add(chunk);
				}
				entry.unshiftChunk(chunk);
				chunk.addGroup(entry);
				entry.setRuntimeChunk(chunk);
			}
		}
		buildChunkGraph(this, chunkGraphInit);
		this.hooks.afterChunks.call(this.chunks);
		this.logger.timeEnd("create chunks");

		this.logger.time("optimize");
		this.hooks.optimize.call();

		while (this.hooks.optimizeModules.call(this.modules)) {
			/* empty */
		}
		this.hooks.afterOptimizeModules.call(this.modules);

		while (this.hooks.optimizeChunks.call(this.chunks, this.chunkGroups)) {
			/* empty */
		}
		this.hooks.afterOptimizeChunks.call(this.chunks, this.chunkGroups);

		this.hooks.optimizeTree.callAsync(this.chunks, this.modules, err => {
			if (err) {
				return finalCallback(
					makeWebpackError(err, "Compilation.hooks.optimizeTree")
				);
			}

			this.hooks.afterOptimizeTree.call(this.chunks, this.modules);

			this.hooks.optimizeChunkModules.callAsync(
				this.chunks,
				this.modules,
				err => {
					if (err) {
						return finalCallback(
							makeWebpackError(err, "Compilation.hooks.optimizeChunkModules")
						);
					}

					this.hooks.afterOptimizeChunkModules.call(this.chunks, this.modules);

					const shouldRecord = this.hooks.shouldRecord.call() !== false;

					this.hooks.reviveModules.call(this.modules, this.records);
					this.hooks.beforeModuleIds.call(this.modules);
					this.hooks.moduleIds.call(this.modules);
					this.hooks.optimizeModuleIds.call(this.modules);
					this.hooks.afterOptimizeModuleIds.call(this.modules);

					this.hooks.reviveChunks.call(this.chunks, this.records);
					this.hooks.beforeChunkIds.call(this.chunks);
					this.hooks.chunkIds.call(this.chunks);
					this.hooks.optimizeChunkIds.call(this.chunks);
					this.hooks.afterOptimizeChunkIds.call(this.chunks);

					this.assignRuntimeIds();

					this.logger.time("compute affected modules with chunk graph");
					this._computeAffectedModulesWithChunkGraph();
					this.logger.timeEnd("compute affected modules with chunk graph");

					this.sortItemsWithChunkIds();

					if (shouldRecord) {
						this.hooks.recordModules.call(this.modules, this.records);
						this.hooks.recordChunks.call(this.chunks, this.records);
					}

					this.hooks.optimizeCodeGeneration.call(this.modules);
					this.logger.timeEnd("optimize");

					this.logger.time("module hashing");
					this.hooks.beforeModuleHash.call();
					this.createModuleHashes();
					this.hooks.afterModuleHash.call();
					this.logger.timeEnd("module hashing");

					this.logger.time("code generation");
					this.hooks.beforeCodeGeneration.call();
					this.codeGeneration(err => {
						if (err) {
							return finalCallback(err);
						}
						this.hooks.afterCodeGeneration.call();
						this.logger.timeEnd("code generation");

						this.logger.time("runtime requirements");
						this.hooks.beforeRuntimeRequirements.call();
						this.processRuntimeRequirements();
						this.hooks.afterRuntimeRequirements.call();
						this.logger.timeEnd("runtime requirements");

						this.logger.time("hashing");
						this.hooks.beforeHash.call();
						const codeGenerationJobs = this.createHash();
						this.hooks.afterHash.call();
						this.logger.timeEnd("hashing");

						this._runCodeGenerationJobs(codeGenerationJobs, err => {
							if (err) {
								return finalCallback(err);
							}

							if (shouldRecord) {
								this.logger.time("record hash");
								this.hooks.recordHash.call(this.records);
								this.logger.timeEnd("record hash");
							}

							this.logger.time("module assets");
							this.clearAssets();

							this.hooks.beforeModuleAssets.call();
							this.createModuleAssets();
							this.logger.timeEnd("module assets");

							const cont = () => {
								this.logger.time("process assets");
								this.hooks.processAssets.callAsync(this.assets, err => {
									if (err) {
										return finalCallback(
											makeWebpackError(err, "Compilation.hooks.processAssets")
										);
									}
									this.hooks.afterProcessAssets.call(this.assets);
									this.logger.timeEnd("process assets");
									this.assets =  (
										this._backCompat
											? soonFrozenObjectDeprecation(
													this.assets,
													"Compilation.assets",
													"DEP_WEBPACK_COMPILATION_ASSETS",
													`BREAKING CHANGE: No more changes should happen to Compilation.assets after sealing the Compilation.
	Do changes to assets earlier, e. g. in Compilation.hooks.processAssets.
	Make sure to select an appropriate stage from Compilation.PROCESS_ASSETS_STAGE_*.`
												)
											: Object.freeze(this.assets)
									);

									this.summarizeDependencies();
									if (shouldRecord) {
										this.hooks.record.call(this, this.records);
									}

									if (this.hooks.needAdditionalSeal.call()) {
										this.unseal();
										return this.seal(callback);
									}
									return this.hooks.afterSeal.callAsync(err => {
										if (err) {
											return finalCallback(
												makeWebpackError(err, "Compilation.hooks.afterSeal")
											);
										}
										this.fileSystemInfo.logStatistics();
										finalCallback();
									});
								});
							};

							this.logger.time("create chunk assets");
							if (this.hooks.shouldGenerateChunkAssets.call() !== false) {
								this.hooks.beforeChunkAssets.call();
								this.createChunkAssets(err => {
									this.logger.timeEnd("create chunk assets");
									if (err) {
										return finalCallback(err);
									}
									cont();
								});
							} else {
								this.logger.timeEnd("create chunk assets");
								cont();
							}
						});
					});
				}
			);
		});
	}
 
	reportDependencyErrorsAndWarnings(module, blocks) {
		let hasProblems = false;
		for (let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const block = blocks[indexBlock];
			const dependencies = block.dependencies;

			for (let indexDep = 0; indexDep < dependencies.length; indexDep++) {
				const d = dependencies[indexDep];

				const warnings = d.getWarnings(this.moduleGraph);
				if (warnings) {
					for (let indexWar = 0; indexWar < warnings.length; indexWar++) {
						const w = warnings[indexWar];

						const warning = new ModuleDependencyWarning(module, w, d.loc);
						this.warnings.push(warning);
						hasProblems = true;
					}
				}
				const errors = d.getErrors(this.moduleGraph);
				if (errors) {
					for (let indexErr = 0; indexErr < errors.length; indexErr++) {
						const e = errors[indexErr];

						const error = new ModuleDependencyError(module, e, d.loc);
						this.errors.push(error);
						hasProblems = true;
					}
				}
			}

			if (this.reportDependencyErrorsAndWarnings(module, block.blocks))
				hasProblems = true;
		}
		return hasProblems;
	}
 
	codeGeneration(callback) {
		const { chunkGraph } = this;
		this.codeGenerationResults = new CodeGenerationResults(
			this.outputOptions.hashFunction
		);
		
		const jobs = [];
		for (const module of this.modules) {
			const runtimes = chunkGraph.getModuleRuntimes(module);
			if (runtimes.size === 1) {
				for (const runtime of runtimes) {
					const hash = chunkGraph.getModuleHash(module, runtime);
					jobs.push({ module, hash, runtime, runtimes: [runtime] });
				}
			} else if (runtimes.size > 1) {
				
				const map = new Map();
				for (const runtime of runtimes) {
					const hash = chunkGraph.getModuleHash(module, runtime);
					const job = map.get(hash);
					if (job === undefined) {
						const newJob = { module, hash, runtime, runtimes: [runtime] };
						jobs.push(newJob);
						map.set(hash, newJob);
					} else {
						job.runtimes.push(runtime);
					}
				}
			}
		}

		this._runCodeGenerationJobs(jobs, callback);
	} 
	_runCodeGenerationJobs(jobs, callback) {
		if (jobs.length === 0) {
			return callback();
		}
		let statModulesFromCache = 0;
		let statModulesGenerated = 0;
		const { chunkGraph, moduleGraph, dependencyTemplates, runtimeTemplate } =
			this;
		const results = this.codeGenerationResults;
		
		const errors = [];
		
		let notCodeGeneratedModules;
		const runIteration = () => {
			
			let delayedJobs = [];
			let delayedModules = new Set();
			asyncLib.eachLimit(
				jobs,
				
				(this.options.parallelism),
				(job, callback) => {
					const { module } = job;
					const { codeGenerationDependencies } = module;
					if (
						codeGenerationDependencies !== undefined &&
						(notCodeGeneratedModules === undefined ||
							codeGenerationDependencies.some(dep => {
								const referencedModule =  (
									moduleGraph.getModule(dep)
								);
								return  (
									notCodeGeneratedModules
								).has(referencedModule);
							}))
					) {
						delayedJobs.push(job);
						delayedModules.add(module);
						return callback();
					}
					const { hash, runtime, runtimes } = job;
					this._codeGenerationModule(
						module,
						runtime,
						runtimes,
						hash,
						dependencyTemplates,
						chunkGraph,
						moduleGraph,
						runtimeTemplate,
						errors,
						results,
						(err, codeGenerated) => {
							if (codeGenerated) statModulesGenerated++;
							else statModulesFromCache++;
							callback(err);
						}
					);
				},
				err => {
					if (err) return callback(err);
					if (delayedJobs.length > 0) {
						if (delayedJobs.length === jobs.length) {
							return callback(
								 (
									new Error(
										`Unable to make progress during code generation because of circular code generation dependency: ${Array.from(
											delayedModules,
											m => m.identifier()
										).join(", ")}`
									)
								)
							);
						}
						jobs = delayedJobs;
						delayedJobs = [];
						notCodeGeneratedModules = delayedModules;
						delayedModules = new Set();
						return runIteration();
					}
					if (errors.length > 0) {
						errors.sort(
							compareSelect(err => err.module, compareModulesByIdentifier)
						);
						for (const error of errors) {
							this.errors.push(error);
						}
					}
					this.logger.log(
						`${Math.round(
							(100 * statModulesGenerated) /
								(statModulesGenerated + statModulesFromCache)
						)}% code generated (${statModulesGenerated} generated, ${statModulesFromCache} from cache)`
					);
					callback();
				}
			);
		};
		runIteration();
	} 
	_codeGenerationModule(
		module,
		runtime,
		runtimes,
		hash,
		dependencyTemplates,
		chunkGraph,
		moduleGraph,
		runtimeTemplate,
		errors,
		results,
		callback
	) {
		let codeGenerated = false;
		const cache = new MultiItemCache(
			runtimes.map(runtime =>
				this._codeGenerationCache.getItemCache(
					`${module.identifier()}|${getRuntimeKey(runtime)}`,
					`${hash}|${dependencyTemplates.getHash()}`
				)
			)
		);
		cache.get((err, cachedResult) => {
			if (err) return callback( (err));
			let result;
			if (!cachedResult) {
				try {
					codeGenerated = true;
					this.codeGeneratedModules.add(module);
					result = module.codeGeneration({
						chunkGraph,
						moduleGraph,
						dependencyTemplates,
						runtimeTemplate,
						runtime,
						codeGenerationResults: results,
						compilation: this
					});
				} catch (err) {
					errors.push(
						new CodeGenerationError(module,  (err))
					);
					result = cachedResult = {
						sources: new Map(),
						runtimeRequirements: null
					};
				}
			} else {
				result = cachedResult;
			}
			for (const runtime of runtimes) {
				results.add(module, runtime, result);
			}
			if (!cachedResult) {
				cache.store(result, err =>
					callback( (err), codeGenerated)
				);
			} else {
				callback(null, codeGenerated);
			}
		});
	}

	_getChunkGraphEntries() {
		
		const treeEntries = new Set();
		for (const ep of this.entrypoints.values()) {
			const chunk = ep.getRuntimeChunk();
			if (chunk) treeEntries.add(chunk);
		}
		for (const ep of this.asyncEntrypoints) {
			const chunk = ep.getRuntimeChunk();
			if (chunk) treeEntries.add(chunk);
		}
		return treeEntries;
	}
 
	processRuntimeRequirements({
		chunkGraph = this.chunkGraph,
		modules = this.modules,
		chunks = this.chunks,
		codeGenerationResults = this.codeGenerationResults,
		chunkGraphEntries = this._getChunkGraphEntries()
	} = {}) {
		const context = { chunkGraph, codeGenerationResults };
		const { moduleMemCaches2 } = this;
		this.logger.time("runtime requirements.modules");
		const additionalModuleRuntimeRequirements =
			this.hooks.additionalModuleRuntimeRequirements;
		const runtimeRequirementInModule = this.hooks.runtimeRequirementInModule;
		for (const module of modules) {
			if (chunkGraph.getNumberOfModuleChunks(module) > 0) {
				const memCache = moduleMemCaches2 && moduleMemCaches2.get(module);
				for (const runtime of chunkGraph.getModuleRuntimes(module)) {
					if (memCache) {
						const cached = memCache.get(
							`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`
						);
						if (cached !== undefined) {
							if (cached !== null) {
								chunkGraph.addModuleRuntimeRequirements(
									module,
									runtime,
									cached,
									false
								);
							}
							continue;
						}
					}
					let set;
					const runtimeRequirements =
						codeGenerationResults.getRuntimeRequirements(module, runtime);
					if (runtimeRequirements && runtimeRequirements.size > 0) {
						set = new Set(runtimeRequirements);
					} else if (additionalModuleRuntimeRequirements.isUsed()) {
						set = new Set();
					} else {
						if (memCache) {
							memCache.set(
								`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`,
								null
							);
						}
						continue;
					}
					additionalModuleRuntimeRequirements.call(module, set, context);

					for (const r of set) {
						const hook = runtimeRequirementInModule.get(r);
						if (hook !== undefined) hook.call(module, set, context);
					}
					if (set.size === 0) {
						if (memCache) {
							memCache.set(
								`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`,
								null
							);
						}
					} else if (memCache) {
						memCache.set(
							`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`,
							set
						);
						chunkGraph.addModuleRuntimeRequirements(
							module,
							runtime,
							set,
							false
						);
					} else {
						chunkGraph.addModuleRuntimeRequirements(module, runtime, set);
					}
				}
			}
		}
		this.logger.timeEnd("runtime requirements.modules");

		this.logger.time("runtime requirements.chunks");
		for (const chunk of chunks) {
			const set = new Set();
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				const runtimeRequirements = chunkGraph.getModuleRuntimeRequirements(
					module,
					chunk.runtime
				);
				for (const r of runtimeRequirements) set.add(r);
			}
			this.hooks.additionalChunkRuntimeRequirements.call(chunk, set, context);

			for (const r of set) {
				this.hooks.runtimeRequirementInChunk.for(r).call(chunk, set, context);
			}

			chunkGraph.addChunkRuntimeRequirements(chunk, set);
		}
		this.logger.timeEnd("runtime requirements.chunks");

		this.logger.time("runtime requirements.entries");
		for (const treeEntry of chunkGraphEntries) {
			const set = new Set();
			for (const chunk of treeEntry.getAllReferencedChunks()) {
				const runtimeRequirements =
					chunkGraph.getChunkRuntimeRequirements(chunk);
				for (const r of runtimeRequirements) set.add(r);
			}

			this.hooks.additionalTreeRuntimeRequirements.call(
				treeEntry,
				set,
				context
			);

			for (const r of set) {
				this.hooks.runtimeRequirementInTree
					.for(r)
					.call(treeEntry, set, context);
			}

			chunkGraph.addTreeRuntimeRequirements(treeEntry, set);
		}
		this.logger.timeEnd("runtime requirements.entries");
	}

	// TODO webpack 6 make chunkGraph argument non-optional 
	addRuntimeModule(chunk, module, chunkGraph = this.chunkGraph) {
		// Deprecated ModuleGraph association
		if (this._backCompat)
			ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);

		// add it to the list
		this.modules.add(module);
		this._modules.set(module.identifier(), module);

		// connect to the chunk graph
		chunkGraph.connectChunkAndModule(chunk, module);
		chunkGraph.connectChunkAndRuntimeModule(chunk, module);
		if (module.fullHash) {
			chunkGraph.addFullHashModuleToChunk(chunk, module);
		} else if (module.dependentHash) {
			chunkGraph.addDependentHashModuleToChunk(chunk, module);
		}

		// attach runtime module
		module.attach(this, chunk, chunkGraph);

		// Setup internals
		const exportsInfo = this.moduleGraph.getExportsInfo(module);
		exportsInfo.setHasProvideInfo();
		if (typeof chunk.runtime === "string") {
			exportsInfo.setUsedForSideEffectsOnly(chunk.runtime);
		} else if (chunk.runtime === undefined) {
			exportsInfo.setUsedForSideEffectsOnly(undefined);
		} else {
			for (const runtime of chunk.runtime) {
				exportsInfo.setUsedForSideEffectsOnly(runtime);
			}
		}
		chunkGraph.addModuleRuntimeRequirements(
			module,
			chunk.runtime,
			new Set([RuntimeGlobals.requireScope])
		);

		// runtime modules don't need ids
		chunkGraph.setModuleId(module, "");

		// Call hook
		this.hooks.runtimeModule.call(module, chunk);
	}

 
	addChunkInGroup(groupOptions, module, loc, request) {
		if (typeof groupOptions === "string") {
			groupOptions = { name: groupOptions };
		}
		const name = groupOptions.name;

		if (name) {
			const chunkGroup = this.namedChunkGroups.get(name);
			if (chunkGroup !== undefined) {
				chunkGroup.addOptions(groupOptions);
				if (module) {
					chunkGroup.addOrigin(
						module,
						
						(loc),
						request
					);
				}
				return chunkGroup;
			}
		}
		const chunkGroup = new ChunkGroup(groupOptions);
		if (module)
			chunkGroup.addOrigin(
				module,
				
				(loc),
				request
			);
		const chunk = this.addChunk(name);

		connectChunkGroupAndChunk(chunkGroup, chunk);

		this.chunkGroups.push(chunkGroup);
		if (name) {
			this.namedChunkGroups.set(name, chunkGroup);
		}
		return chunkGroup;
	}

	 
	addAsyncEntrypoint(options, module, loc, request) {
		const name = options.name;
		if (name) {
			const entrypoint = this.namedChunkGroups.get(name);
			if (entrypoint instanceof Entrypoint) {
				if (entrypoint !== undefined) {
					if (module) {
						entrypoint.addOrigin(module, loc, request);
					}
					return entrypoint;
				}
			} else if (entrypoint) {
				throw new Error(
					`Cannot add an async entrypoint with the name '${name}', because there is already an chunk group with this name`
				);
			}
		}
		const chunk = this.addChunk(name);
		if (options.filename) {
			chunk.filenameTemplate = options.filename;
		}
		const entrypoint = new Entrypoint(options, false);
		entrypoint.setRuntimeChunk(chunk);
		entrypoint.setEntrypointChunk(chunk);
		if (name) {
			this.namedChunkGroups.set(name, entrypoint);
		}
		this.chunkGroups.push(entrypoint);
		this.asyncEntrypoints.push(entrypoint);
		connectChunkGroupAndChunk(entrypoint, chunk);
		if (module) {
			entrypoint.addOrigin(module, loc, request);
		}
		return entrypoint;
	}

	 
	addChunk(name) {
		if (name) {
			const chunk = this.namedChunks.get(name);
			if (chunk !== undefined) {
				return chunk;
			}
		}
		const chunk = new Chunk(name, this._backCompat);
		this.chunks.add(chunk);
		if (this._backCompat)
			ChunkGraph.setChunkGraphForChunk(chunk, this.chunkGraph);
		if (name) {
			this.namedChunks.set(name, chunk);
		}
		return chunk;
	}
 
	assignDepth(module) {
		const moduleGraph = this.moduleGraph;

		const queue = new Set([module]);
		
		let depth;

		moduleGraph.setDepth(module, 0);
 
		const processModule = module => {
			if (!moduleGraph.setDepthIfLower(module, depth)) return;
			queue.add(module);
		};

		for (module of queue) {
			queue.delete(module);
			depth =  (moduleGraph.getDepth(module)) + 1;

			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const refModule = connection.module;
				if (refModule) {
					processModule(refModule);
				}
			}
		}
	}

	 
	assignDepths(modules) {
		const moduleGraph = this.moduleGraph;

		
		const queue = new Set(modules);
		queue.add(1);
		let depth = 0;

		let i = 0;
		for (const module of queue) {
			i++;
			if (typeof module === "number") {
				depth = module;
				if (queue.size === i) return;
				queue.add(depth + 1);
			} else {
				moduleGraph.setDepth(module, depth);
				for (const { module: refModule } of moduleGraph.getOutgoingConnections(
					module
				)) {
					if (refModule) {
						queue.add(refModule);
					}
				}
			}
		}
	} 
	getDependencyReferencedExports(dependency, runtime) {
		const referencedExports = dependency.getReferencedExports(
			this.moduleGraph,
			runtime
		);
		return this.hooks.dependencyReferencedExports.call(
			referencedExports,
			dependency,
			runtime
		);
	}
 
	removeReasonsOfDependencyBlock(module, block) {
		if (block.blocks) {
			for (const b of block.blocks) {
				this.removeReasonsOfDependencyBlock(module, b);
			}
		}

		if (block.dependencies) {
			for (const dep of block.dependencies) {
				const originalModule = this.moduleGraph.getModule(dep);
				if (originalModule) {
					this.moduleGraph.removeConnection(dep);

					if (this.chunkGraph) {
						for (const chunk of this.chunkGraph.getModuleChunks(
							originalModule
						)) {
							this.patchChunksAfterReasonRemoval(originalModule, chunk);
						}
					}
				}
			}
		}
	}
 
	patchChunksAfterReasonRemoval(module, chunk) {
		if (!module.hasReasons(this.moduleGraph, chunk.runtime)) {
			this.removeReasonsOfDependencyBlock(module, module);
		}
		if (
			!module.hasReasonForChunk(chunk, this.moduleGraph, this.chunkGraph) &&
			this.chunkGraph.isModuleInChunk(module, chunk)
		) {
			this.chunkGraph.disconnectChunkAndModule(chunk, module);
			this.removeChunkFromDependencies(module, chunk);
		}
	}
 
	removeChunkFromDependencies(block, chunk) { 
		const iteratorDependency = d => {
			const depModule = this.moduleGraph.getModule(d);
			if (!depModule) {
				return;
			}
			this.patchChunksAfterReasonRemoval(depModule, chunk);
		};

		const blocks = block.blocks;
		for (let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const asyncBlock = blocks[indexBlock];
			const chunkGroup =
				
				(this.chunkGraph.getBlockChunkGroup(asyncBlock));
			// Grab all chunks from the first Block's AsyncDepBlock
			const chunks = chunkGroup.chunks;
			// For each chunk in chunkGroup
			for (let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
				const iteratedChunk = chunks[indexChunk];
				chunkGroup.removeChunk(iteratedChunk);
				// Recurse
				this.removeChunkFromDependencies(block, iteratedChunk);
			}
		}

		if (block.dependencies) {
			for (const dep of block.dependencies) iteratorDependency(dep);
		}
	}

	assignRuntimeIds() {
		const { chunkGraph } = this;
		const processEntrypoint = ep => {
			const runtime = ep.options.runtime || ep.name;
			const chunk = ep.getRuntimeChunk();
			chunkGraph.setRuntimeId(runtime, chunk.id);
		};
		for (const ep of this.entrypoints.values()) {
			processEntrypoint(ep);
		}
		for (const ep of this.asyncEntrypoints) {
			processEntrypoint(ep);
		}
	}

	sortItemsWithChunkIds() {
		for (const chunkGroup of this.chunkGroups) {
			chunkGroup.sortItems();
		}

		this.errors.sort(compareErrors);
		this.warnings.sort(compareErrors);
		this.children.sort(byNameOrHash);
	}

	summarizeDependencies() {
		for (
			let indexChildren = 0;
			indexChildren < this.children.length;
			indexChildren++
		) {
			const child = this.children[indexChildren];

			this.fileDependencies.addAll(child.fileDependencies);
			this.contextDependencies.addAll(child.contextDependencies);
			this.missingDependencies.addAll(child.missingDependencies);
			this.buildDependencies.addAll(child.buildDependencies);
		}

		for (const module of this.modules) {
			module.addCacheDependencies(
				this.fileDependencies,
				this.contextDependencies,
				this.missingDependencies,
				this.buildDependencies
			);
		}
	}

	createModuleHashes() {
		let statModulesHashed = 0;
		let statModulesFromCache = 0;
		const { chunkGraph, runtimeTemplate, moduleMemCaches2 } = this;
		const { hashFunction, hashDigest, hashDigestLength } = this.outputOptions;
		
		const errors = [];
		for (const module of this.modules) {
			const memCache = moduleMemCaches2 && moduleMemCaches2.get(module);
			for (const runtime of chunkGraph.getModuleRuntimes(module)) {
				if (memCache) {
					const digest = memCache.get(`moduleHash-${getRuntimeKey(runtime)}`);
					if (digest !== undefined) {
						chunkGraph.setModuleHashes(
							module,
							runtime,
							digest,
							digest.slice(0, hashDigestLength)
						);
						statModulesFromCache++;
						continue;
					}
				}
				statModulesHashed++;
				const digest = this._createModuleHash(
					module,
					chunkGraph,
					runtime,
					hashFunction,
					runtimeTemplate,
					hashDigest,
					hashDigestLength,
					errors
				);
				if (memCache) {
					memCache.set(`moduleHash-${getRuntimeKey(runtime)}`, digest);
				}
			}
		}
		if (errors.length > 0) {
			errors.sort(compareSelect(err => err.module, compareModulesByIdentifier));
			for (const error of errors) {
				this.errors.push(error);
			}
		}
		this.logger.log(
			`${statModulesHashed} modules hashed, ${statModulesFromCache} from cache (${
				Math.round(
					(100 * (statModulesHashed + statModulesFromCache)) / this.modules.size
				) / 100
			} variants per module in average)`
		);
	}
 
	_createModuleHash(
		module,
		chunkGraph,
		runtime,
		hashFunction,
		runtimeTemplate,
		hashDigest,
		hashDigestLength,
		errors
	) {
		let moduleHashDigest;
		try {
			const moduleHash = createHash(hashFunction);
			module.updateHash(moduleHash, {
				chunkGraph,
				runtime,
				runtimeTemplate
			});
			moduleHashDigest =  (moduleHash.digest(hashDigest));
		} catch (err) {
			errors.push(new ModuleHashingError(module,  (err)));
			moduleHashDigest = "XXXXXX";
		}
		chunkGraph.setModuleHashes(
			module,
			runtime,
			moduleHashDigest,
			moduleHashDigest.slice(0, hashDigestLength)
		);
		return moduleHashDigest;
	}

	createHash() {
		this.logger.time("hashing: initialize hash");
		const chunkGraph =  (this.chunkGraph);
		const runtimeTemplate = this.runtimeTemplate;
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = createHash(hashFunction);
		if (outputOptions.hashSalt) {
			hash.update(outputOptions.hashSalt);
		}
		this.logger.timeEnd("hashing: initialize hash");
		if (this.children.length > 0) {
			this.logger.time("hashing: hash child compilations");
			for (const child of this.children) {
				hash.update(child.hash);
			}
			this.logger.timeEnd("hashing: hash child compilations");
		}
		if (this.warnings.length > 0) {
			this.logger.time("hashing: hash warnings");
			for (const warning of this.warnings) {
				hash.update(`${warning.message}`);
			}
			this.logger.timeEnd("hashing: hash warnings");
		}
		if (this.errors.length > 0) {
			this.logger.time("hashing: hash errors");
			for (const error of this.errors) {
				hash.update(`${error.message}`);
			}
			this.logger.timeEnd("hashing: hash errors");
		}

		this.logger.time("hashing: sort chunks");
		/*
		 * all non-runtime chunks need to be hashes first,
		 * since runtime chunk might use their hashes.
		 * runtime chunks need to be hashed in the correct order
		 * since they may depend on each other (for async entrypoints).
		 * So we put all non-runtime chunks first and hash them in any order.
		 * And order runtime chunks according to referenced between each other.
		 * Chunks need to be in deterministic order since we add hashes to full chunk
		 * during these hashing.
		 */
		
		const unorderedRuntimeChunks = [];
		
		const otherChunks = [];
		for (const c of this.chunks) {
			if (c.hasRuntime()) {
				unorderedRuntimeChunks.push(c);
			} else {
				otherChunks.push(c);
			}
		}
		unorderedRuntimeChunks.sort(byId);
		otherChunks.sort(byId);

		
		
		const runtimeChunksMap = new Map();
		for (const chunk of unorderedRuntimeChunks) {
			runtimeChunksMap.set(chunk, {
				chunk,
				referencedBy: [],
				remaining: 0
			});
		}
		let remaining = 0;
		for (const info of runtimeChunksMap.values()) {
			for (const other of new Set(
				Array.from(info.chunk.getAllReferencedAsyncEntrypoints()).map(
					e => e.chunks[e.chunks.length - 1]
				)
			)) {
				const otherInfo = runtimeChunksMap.get(other);
				otherInfo.referencedBy.push(info);
				info.remaining++;
				remaining++;
			}
		}
		
		const runtimeChunks = [];
		for (const info of runtimeChunksMap.values()) {
			if (info.remaining === 0) {
				runtimeChunks.push(info.chunk);
			}
		}
		// If there are any references between chunks
		// make sure to follow these chains
		if (remaining > 0) {
			const readyChunks = [];
			for (const chunk of runtimeChunks) {
				const hasFullHashModules =
					chunkGraph.getNumberOfChunkFullHashModules(chunk) !== 0;
				const info =
					
					(runtimeChunksMap.get(chunk));
				for (const otherInfo of info.referencedBy) {
					if (hasFullHashModules) {
						chunkGraph.upgradeDependentToFullHashModules(otherInfo.chunk);
					}
					remaining--;
					if (--otherInfo.remaining === 0) {
						readyChunks.push(otherInfo.chunk);
					}
				}
				if (readyChunks.length > 0) {
					// This ensures deterministic ordering, since referencedBy is non-deterministic
					readyChunks.sort(byId);
					for (const c of readyChunks) runtimeChunks.push(c);
					readyChunks.length = 0;
				}
			}
		}
		// If there are still remaining references we have cycles and want to create a warning
		if (remaining > 0) {
			const circularRuntimeChunkInfo = [];
			for (const info of runtimeChunksMap.values()) {
				if (info.remaining !== 0) {
					circularRuntimeChunkInfo.push(info);
				}
			}
			circularRuntimeChunkInfo.sort(compareSelect(i => i.chunk, byId));
			const err =
				new WebpackError(`Circular dependency between chunks with runtime (${Array.from(
					circularRuntimeChunkInfo,
					c => c.chunk.name || c.chunk.id
				).join(", ")})
This prevents using hashes of each other and should be avoided.`);
			err.chunk = circularRuntimeChunkInfo[0].chunk;
			this.warnings.push(err);
			for (const i of circularRuntimeChunkInfo) runtimeChunks.push(i.chunk);
		}
		this.logger.timeEnd("hashing: sort chunks");

		const fullHashChunks = new Set();
		
		const codeGenerationJobs = [];
		
		const codeGenerationJobsMap = new Map();
		
		const errors = [];
 
		const processChunk = chunk => {
			// Last minute module hash generation for modules that depend on chunk hashes
			this.logger.time("hashing: hash runtime modules");
			const runtime = chunk.runtime;
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!chunkGraph.hasModuleHashes(module, runtime)) {
					const hash = this._createModuleHash(
						module,
						chunkGraph,
						runtime,
						hashFunction,
						runtimeTemplate,
						hashDigest,
						hashDigestLength,
						errors
					);
					let hashMap = codeGenerationJobsMap.get(hash);
					if (hashMap) {
						const moduleJob = hashMap.get(module);
						if (moduleJob) {
							moduleJob.runtimes.push(runtime);
							continue;
						}
					} else {
						hashMap = new Map();
						codeGenerationJobsMap.set(hash, hashMap);
					}
					const job = {
						module,
						hash,
						runtime,
						runtimes: [runtime]
					};
					hashMap.set(module, job);
					codeGenerationJobs.push(job);
				}
			}
			this.logger.timeAggregate("hashing: hash runtime modules");
			try {
				this.logger.time("hashing: hash chunks");
				const chunkHash = createHash(hashFunction);
				if (outputOptions.hashSalt) {
					chunkHash.update(outputOptions.hashSalt);
				}
				chunk.updateHash(chunkHash, chunkGraph);
				this.hooks.chunkHash.call(chunk, chunkHash, {
					chunkGraph,
					codeGenerationResults: this.codeGenerationResults,
					moduleGraph: this.moduleGraph,
					runtimeTemplate: this.runtimeTemplate
				});
				const chunkHashDigest =  (
					chunkHash.digest(hashDigest)
				);
				hash.update(chunkHashDigest);
				chunk.hash = chunkHashDigest;
				chunk.renderedHash = chunk.hash.slice(0, hashDigestLength);
				const fullHashModules =
					chunkGraph.getChunkFullHashModulesIterable(chunk);
				if (fullHashModules) {
					fullHashChunks.add(chunk);
				} else {
					this.hooks.contentHash.call(chunk);
				}
			} catch (err) {
				this.errors.push(
					new ChunkRenderError(chunk, "",  (err))
				);
			}
			this.logger.timeAggregate("hashing: hash chunks");
		};
		for (const chunk of otherChunks) processChunk(chunk);
		for (const chunk of runtimeChunks) processChunk(chunk);
		if (errors.length > 0) {
			errors.sort(compareSelect(err => err.module, compareModulesByIdentifier));
			for (const error of errors) {
				this.errors.push(error);
			}
		}

		this.logger.timeAggregateEnd("hashing: hash runtime modules");
		this.logger.timeAggregateEnd("hashing: hash chunks");
		this.logger.time("hashing: hash digest");
		this.hooks.fullHash.call(hash);
		this.fullHash =  (hash.digest(hashDigest));
		this.hash = this.fullHash.slice(0, hashDigestLength);
		this.logger.timeEnd("hashing: hash digest");

		this.logger.time("hashing: process full hash modules");
		for (const chunk of fullHashChunks) {
			for (const module of  (
				chunkGraph.getChunkFullHashModulesIterable(chunk)
			)) {
				const moduleHash = createHash(hashFunction);
				module.updateHash(moduleHash, {
					chunkGraph,
					runtime: chunk.runtime,
					runtimeTemplate
				});
				const moduleHashDigest =  (
					moduleHash.digest(hashDigest)
				);
				const oldHash = chunkGraph.getModuleHash(module, chunk.runtime);
				chunkGraph.setModuleHashes(
					module,
					chunk.runtime,
					moduleHashDigest,
					moduleHashDigest.slice(0, hashDigestLength)
				);
				codeGenerationJobsMap.get(oldHash).get(module).hash = moduleHashDigest;
			}
			const chunkHash = createHash(hashFunction);
			chunkHash.update(chunk.hash);
			chunkHash.update(this.hash);
			const chunkHashDigest =
				
				(chunkHash.digest(hashDigest));
			chunk.hash = chunkHashDigest;
			chunk.renderedHash = chunk.hash.slice(0, hashDigestLength);
			this.hooks.contentHash.call(chunk);
		}
		this.logger.timeEnd("hashing: process full hash modules");
		return codeGenerationJobs;
	}
 
	emitAsset(file, source, assetInfo = {}) {
		if (this.assets[file]) {
			if (!isSourceEqual(this.assets[file], source)) {
				this.errors.push(
					new WebpackError(
						`Conflict: Multiple assets emit different content to the same filename ${file}${
							assetInfo.sourceFilename
								? `. Original source ${assetInfo.sourceFilename}`
								: ""
						}`
					)
				);
				this.assets[file] = source;
				this._setAssetInfo(file, assetInfo);
				return;
			}
			const oldInfo = this.assetsInfo.get(file);
			const newInfo = { ...oldInfo, ...assetInfo };
			this._setAssetInfo(file, newInfo, oldInfo);
			return;
		}
		this.assets[file] = source;
		this._setAssetInfo(file, assetInfo, undefined);
	}

	_setAssetInfo(file, newInfo, oldInfo = this.assetsInfo.get(file)) {
		if (newInfo === undefined) {
			this.assetsInfo.delete(file);
		} else {
			this.assetsInfo.set(file, newInfo);
		}
		const oldRelated = oldInfo && oldInfo.related;
		const newRelated = newInfo && newInfo.related;
		if (oldRelated) {
			for (const key of Object.keys(oldRelated)) { 
				const remove = name => {
					const relatedIn = this._assetsRelatedIn.get(name);
					if (relatedIn === undefined) return;
					const entry = relatedIn.get(key);
					if (entry === undefined) return;
					entry.delete(file);
					if (entry.size !== 0) return;
					relatedIn.delete(key);
					if (relatedIn.size === 0) this._assetsRelatedIn.delete(name);
				};
				const entry = oldRelated[key];
				if (Array.isArray(entry)) {
					for (const name of entry) {
						remove(name);
					}
				} else if (entry) {
					remove(entry);
				}
			}
		}
		if (newRelated) {
			for (const key of Object.keys(newRelated)) { 
				const add = name => {
					let relatedIn = this._assetsRelatedIn.get(name);
					if (relatedIn === undefined) {
						this._assetsRelatedIn.set(name, (relatedIn = new Map()));
					}
					let entry = relatedIn.get(key);
					if (entry === undefined) {
						relatedIn.set(key, (entry = new Set()));
					}
					entry.add(file);
				};
				const entry = newRelated[key];
				if (Array.isArray(entry)) {
					for (const name of entry) {
						add(name);
					}
				} else if (entry) {
					add(entry);
				}
			}
		}
	}

 
	updateAsset(
		file,
		newSourceOrFunction,
		assetInfoUpdateOrFunction = undefined
	) {
		if (!this.assets[file]) {
			throw new Error(
				`Called Compilation.updateAsset for not existing filename ${file}`
			);
		}
		this.assets[file] =
			typeof newSourceOrFunction === "function"
				? newSourceOrFunction(this.assets[file])
				: newSourceOrFunction;
		if (assetInfoUpdateOrFunction !== undefined) {
			const oldInfo = this.assetsInfo.get(file) || EMPTY_ASSET_INFO;
			if (typeof assetInfoUpdateOrFunction === "function") {
				this._setAssetInfo(file, assetInfoUpdateOrFunction(oldInfo), oldInfo);
			} else {
				this._setAssetInfo(
					file,
					cachedCleverMerge(oldInfo, assetInfoUpdateOrFunction),
					oldInfo
				);
			}
		}
	}
 
	renameAsset(file, newFile) {
		const source = this.assets[file];
		if (!source) {
			throw new Error(
				`Called Compilation.renameAsset for not existing filename ${file}`
			);
		}
		if (this.assets[newFile] && !isSourceEqual(this.assets[file], source)) {
			this.errors.push(
				new WebpackError(
					`Conflict: Called Compilation.renameAsset for already existing filename ${newFile} with different content`
				)
			);
		}
		const assetInfo = this.assetsInfo.get(file);
		// Update related in all other assets
		const relatedInInfo = this._assetsRelatedIn.get(file);
		if (relatedInInfo) {
			for (const [key, assets] of relatedInInfo) {
				for (const name of assets) {
					const info = this.assetsInfo.get(name);
					if (!info) continue;
					const related = info.related;
					if (!related) continue;
					const entry = related[key];
					let newEntry;
					if (Array.isArray(entry)) {
						newEntry = entry.map(x => (x === file ? newFile : x));
					} else if (entry === file) {
						newEntry = newFile;
					} else continue;
					this.assetsInfo.set(name, {
						...info,
						related: {
							...related,
							[key]: newEntry
						}
					});
				}
			}
		}
		this._setAssetInfo(file, undefined, assetInfo);
		this._setAssetInfo(newFile, assetInfo);
		delete this.assets[file];
		this.assets[newFile] = source;
		for (const chunk of this.chunks) {
			{
				const size = chunk.files.size;
				chunk.files.delete(file);
				if (size !== chunk.files.size) {
					chunk.files.add(newFile);
				}
			}
			{
				const size = chunk.auxiliaryFiles.size;
				chunk.auxiliaryFiles.delete(file);
				if (size !== chunk.auxiliaryFiles.size) {
					chunk.auxiliaryFiles.add(newFile);
				}
			}
		}
	}
 
	deleteAsset(file) {
		if (!this.assets[file]) {
			return;
		}
		delete this.assets[file];
		const assetInfo = this.assetsInfo.get(file);
		this._setAssetInfo(file, undefined, assetInfo);
		const related = assetInfo && assetInfo.related;
		if (related) {
			for (const key of Object.keys(related)) { 
				const checkUsedAndDelete = file => {
					if (!this._assetsRelatedIn.has(file)) {
						this.deleteAsset(file);
					}
				};
				const items = related[key];
				if (Array.isArray(items)) {
					for (const file of items) {
						checkUsedAndDelete(file);
					}
				} else if (items) {
					checkUsedAndDelete(items);
				}
			}
		}
		// TODO If this becomes a performance problem
		// store a reverse mapping from asset to chunk
		for (const chunk of this.chunks) {
			chunk.files.delete(file);
			chunk.auxiliaryFiles.delete(file);
		}
	}

	getAssets() {
		
		const array = [];
		for (const assetName of Object.keys(this.assets)) {
			if (Object.prototype.hasOwnProperty.call(this.assets, assetName)) {
				array.push({
					name: assetName,
					source: this.assets[assetName],
					info: this.assetsInfo.get(assetName) || EMPTY_ASSET_INFO
				});
			}
		}
		return array;
	}
 
	getAsset(name) {
		if (!Object.prototype.hasOwnProperty.call(this.assets, name)) return;
		return {
			name,
			source: this.assets[name],
			info: this.assetsInfo.get(name) || EMPTY_ASSET_INFO
		};
	}

	clearAssets() {
		for (const chunk of this.chunks) {
			chunk.files.clear();
			chunk.auxiliaryFiles.clear();
		}
	}

	createModuleAssets() {
		const { chunkGraph } = this;
		for (const module of this.modules) {
			const buildInfo =  (module.buildInfo);
			if (buildInfo.assets) {
				const assetsInfo = buildInfo.assetsInfo;
				for (const assetName of Object.keys(buildInfo.assets)) {
					const fileName = this.getPath(assetName, {
						chunkGraph: this.chunkGraph,
						module
					});
					for (const chunk of chunkGraph.getModuleChunksIterable(module)) {
						chunk.auxiliaryFiles.add(fileName);
					}
					this.emitAsset(
						fileName,
						buildInfo.assets[assetName],
						assetsInfo ? assetsInfo.get(assetName) : undefined
					);
					this.hooks.moduleAsset.call(module, fileName);
				}
			}
		}
	}

 
	getRenderManifest(options) {
		return this.hooks.renderManifest.call([], options);
	}
 
	createChunkAssets(callback) {
		const outputOptions = this.outputOptions;
		const cachedSourceMap = new WeakMap();
		
		const alreadyWrittenFiles = new Map();

		asyncLib.forEachLimit(
			this.chunks,
			15,
			(chunk, callback) => {
				
				let manifest;
				try {
					manifest = this.getRenderManifest({
						chunk,
						hash: this.hash,
						fullHash: this.fullHash,
						outputOptions,
						codeGenerationResults: this.codeGenerationResults,
						moduleTemplates: this.moduleTemplates,
						dependencyTemplates: this.dependencyTemplates,
						chunkGraph: this.chunkGraph,
						moduleGraph: this.moduleGraph,
						runtimeTemplate: this.runtimeTemplate
					});
				} catch (err) {
					this.errors.push(
						new ChunkRenderError(chunk, "",  (err))
					);
					return callback();
				}
				asyncLib.each(
					manifest,
					(fileManifest, callback) => {
						const ident = fileManifest.identifier;
						const usedHash = fileManifest.hash;

						const assetCacheItem = this._assetsCache.getItemCache(
							ident,
							usedHash
						);

						assetCacheItem.get((err, sourceFromCache) => {
							
							let filenameTemplate;
							
							let file;
							
							let assetInfo;

							let inTry = true; 
							const errorAndCallback = err => {
								const filename =
									file ||
									(typeof file === "string"
										? file
										: typeof filenameTemplate === "string"
											? filenameTemplate
											: "");

								this.errors.push(new ChunkRenderError(chunk, filename, err));
								inTry = false;
								return callback();
							};

							try {
								if ("filename" in fileManifest) {
									file = fileManifest.filename;
									assetInfo = fileManifest.info;
								} else {
									filenameTemplate = fileManifest.filenameTemplate;
									const pathAndInfo = this.getPathWithInfo(
										filenameTemplate,
										fileManifest.pathOptions
									);
									file = pathAndInfo.path;
									assetInfo = fileManifest.info
										? {
												...pathAndInfo.info,
												...fileManifest.info
											}
										: pathAndInfo.info;
								}

								if (err) {
									return errorAndCallback(err);
								}

								let source = sourceFromCache;

								// check if the same filename was already written by another chunk
								const alreadyWritten = alreadyWrittenFiles.get(file);
								if (alreadyWritten !== undefined) {
									if (alreadyWritten.hash !== usedHash) {
										inTry = false;
										return callback(
											new WebpackError(
												`Conflict: Multiple chunks emit assets to the same filename ${file}` +
													` (chunks ${alreadyWritten.chunk.id} and ${chunk.id})`
											)
										);
									}
									source = alreadyWritten.source;
								} else if (!source) {
									// render the asset
									source = fileManifest.render();

									// Ensure that source is a cached source to avoid additional cost because of repeated access
									if (!(source instanceof CachedSource)) {
										const cacheEntry = cachedSourceMap.get(source);
										if (cacheEntry) {
											source = cacheEntry;
										} else {
											const cachedSource = new CachedSource(source);
											cachedSourceMap.set(source, cachedSource);
											source = cachedSource;
										}
									}
								}
								this.emitAsset(file, source, assetInfo);
								if (fileManifest.auxiliary) {
									chunk.auxiliaryFiles.add(file);
								} else {
									chunk.files.add(file);
								}
								this.hooks.chunkAsset.call(chunk, file);
								alreadyWrittenFiles.set(file, {
									hash: usedHash,
									source,
									chunk
								});
								if (source !== sourceFromCache) {
									assetCacheItem.store(source, err => {
										if (err) return errorAndCallback(err);
										inTry = false;
										return callback();
									});
								} else {
									inTry = false;
									callback();
								}
							} catch (err) {
								if (!inTry) throw err;
								errorAndCallback( (err));
							}
						});
					},
					callback
				);
			},
			callback
		);
	}

 
	getPath(filename, data = {}) {
		if (!data.hash) {
			data = {
				hash: this.hash,
				...data
			};
		}
		return this.getAssetPath(filename, data);
	}

 
	getPathWithInfo(filename, data = {}) {
		if (!data.hash) {
			data = {
				hash: this.hash,
				...data
			};
		}
		return this.getAssetPathWithInfo(filename, data);
	}

 
	getAssetPath(filename, data) {
		return this.hooks.assetPath.call(
			typeof filename === "function" ? filename(data) : filename,
			data,
			undefined
		);
	}
 
	getAssetPathWithInfo(filename, data) {
		const assetInfo = {};
		// TODO webpack 5: refactor assetPath hook to receive { path, info } object
		const newPath = this.hooks.assetPath.call(
			typeof filename === "function" ? filename(data, assetInfo) : filename,
			data,
			assetInfo
		);
		return { path: newPath, info: assetInfo };
	}

	getWarnings() {
		return this.hooks.processWarnings.call(this.warnings);
	}

	getErrors() {
		return this.hooks.processErrors.call(this.errors);
	}

	 
	createChildCompiler(name, outputOptions, plugins) {
		const idx = this.childrenCounters[name] || 0;
		this.childrenCounters[name] = idx + 1;
		return this.compiler.createChildCompiler(
			this,
			name,
			idx,
			outputOptions,
			plugins
		);
	}

 
	executeModule(module, options, callback) {
		// Aggregate all referenced modules and ensure they are ready
		const modules = new Set([module]);
		processAsyncTree(
			modules,
			10,
			(module, push, callback) => {
				this.buildQueue.waitFor(module, err => {
					if (err) return callback(err);
					this.processDependenciesQueue.waitFor(module, err => {
						if (err) return callback(err);
						for (const { module: m } of this.moduleGraph.getOutgoingConnections(
							module
						)) {
							const size = modules.size;
							modules.add(m);
							if (modules.size !== size) push(m);
						}
						callback();
					});
				});
			},
			err => {
				if (err) return callback( (err));

				// Create new chunk graph, chunk and entrypoint for the build time execution
				const chunkGraph = new ChunkGraph(
					this.moduleGraph,
					this.outputOptions.hashFunction
				);
				const runtime = "build time";
				const { hashFunction, hashDigest, hashDigestLength } =
					this.outputOptions;
				const runtimeTemplate = this.runtimeTemplate;

				const chunk = new Chunk("build time chunk", this._backCompat);
				chunk.id =  (chunk.name);
				chunk.ids = [chunk.id];
				chunk.runtime = runtime;

				const entrypoint = new Entrypoint({
					runtime,
					chunkLoading: false,
					...options.entryOptions
				});
				chunkGraph.connectChunkAndEntryModule(chunk, module, entrypoint);
				connectChunkGroupAndChunk(entrypoint, chunk);
				entrypoint.setRuntimeChunk(chunk);
				entrypoint.setEntrypointChunk(chunk);

				const chunks = new Set([chunk]);

				// Assign ids to modules and modules to the chunk
				for (const module of modules) {
					const id = module.identifier();
					chunkGraph.setModuleId(module, id);
					chunkGraph.connectChunkAndModule(chunk, module);
				}

				
				const errors = [];

				// Hash modules
				for (const module of modules) {
					this._createModuleHash(
						module,
						chunkGraph,
						runtime,
						hashFunction,
						runtimeTemplate,
						hashDigest,
						hashDigestLength,
						errors
					);
				}

				const codeGenerationResults = new CodeGenerationResults(
					this.outputOptions.hashFunction
				);
				 
				const codeGen = (module, callback) => {
					this._codeGenerationModule(
						module,
						runtime,
						[runtime],
						chunkGraph.getModuleHash(module, runtime),
						this.dependencyTemplates,
						chunkGraph,
						this.moduleGraph,
						runtimeTemplate,
						errors,
						codeGenerationResults,
						(err, codeGenerated) => {
							callback(err);
						}
					);
				};

				const reportErrors = () => {
					if (errors.length > 0) {
						errors.sort(
							compareSelect(err => err.module, compareModulesByIdentifier)
						);
						for (const error of errors) {
							this.errors.push(error);
						}
						errors.length = 0;
					}
				};

				// Generate code for all aggregated modules
				asyncLib.eachLimit(modules, 10, codeGen, err => {
					if (err) return callback(err);
					reportErrors();

					// for backward-compat temporary set the chunk graph
					// TODO webpack 6
					const old = this.chunkGraph;
					this.chunkGraph = chunkGraph;
					this.processRuntimeRequirements({
						chunkGraph,
						modules,
						chunks,
						codeGenerationResults,
						chunkGraphEntries: chunks
					});
					this.chunkGraph = old;

					const runtimeModules =
						chunkGraph.getChunkRuntimeModulesIterable(chunk);

					// Hash runtime modules
					for (const module of runtimeModules) {
						modules.add(module);
						this._createModuleHash(
							module,
							chunkGraph,
							runtime,
							hashFunction,
							runtimeTemplate,
							hashDigest,
							hashDigestLength,
							errors
						);
					}

					// Generate code for all runtime modules
					asyncLib.eachLimit(runtimeModules, 10, codeGen, err => {
						if (err) return callback(err);
						reportErrors();

						
						const moduleArgumentsMap = new Map();
						
						const moduleArgumentsById = new Map();

						
						const fileDependencies = new LazySet();
						
						const contextDependencies = new LazySet();
						
						const missingDependencies = new LazySet();
						
						const buildDependencies = new LazySet();

						
						const assets = new Map();

						let cacheable = true;

						
						const context = {
							assets,
							__webpack_require__: undefined,
							chunk,
							chunkGraph
						};

						// Prepare execution
						asyncLib.eachLimit(
							modules,
							10,
							(module, callback) => {
								const codeGenerationResult = codeGenerationResults.get(
									module,
									runtime
								);
								
								const moduleArgument = {
									module,
									codeGenerationResult,
									preparedInfo: undefined,
									moduleObject: undefined
								};
								moduleArgumentsMap.set(module, moduleArgument);
								moduleArgumentsById.set(module.identifier(), moduleArgument);
								module.addCacheDependencies(
									fileDependencies,
									contextDependencies,
									missingDependencies,
									buildDependencies
								);
								if (
									 (module.buildInfo).cacheable ===
									false
								) {
									cacheable = false;
								}
								if (module.buildInfo && module.buildInfo.assets) {
									const { assets: moduleAssets, assetsInfo } = module.buildInfo;
									for (const assetName of Object.keys(moduleAssets)) {
										assets.set(assetName, {
											source: moduleAssets[assetName],
											info: assetsInfo ? assetsInfo.get(assetName) : undefined
										});
									}
								}
								this.hooks.prepareModuleExecution.callAsync(
									moduleArgument,
									context,
									callback
								);
							},
							err => {
								if (err) return callback(err);

								let exports;
								try {
									const {
										strictModuleErrorHandling,
										strictModuleExceptionHandling
									} = this.outputOptions;
									const __webpack_require__ = id => {
										const cached = moduleCache[id];
										if (cached !== undefined) {
											if (cached.error) throw cached.error;
											return cached.exports;
										}
										const moduleArgument = moduleArgumentsById.get(id);
										return __webpack_require_module__(moduleArgument, id);
									};
									const interceptModuleExecution = (__webpack_require__[
										RuntimeGlobals.interceptModuleExecution.replace(
											`${RuntimeGlobals.require}.`,
											""
										)
									] = []);
									const moduleCache = (__webpack_require__[
										RuntimeGlobals.moduleCache.replace(
											`${RuntimeGlobals.require}.`,
											""
										)
									] = {});

									context.__webpack_require__ = __webpack_require__;

								 
									const __webpack_require_module__ = (moduleArgument, id) => {
										const execOptions = {
											id,
											module: {
												id,
												exports: {},
												loaded: false,
												error: undefined
											},
											require: __webpack_require__
										};
										for (const handler of interceptModuleExecution) {
											handler(execOptions);
										}
										const module = moduleArgument.module;
										this.buildTimeExecutedModules.add(module);
										const moduleObject = execOptions.module;
										moduleArgument.moduleObject = moduleObject;
										try {
											if (id) moduleCache[id] = moduleObject;

											tryRunOrWebpackError(
												() =>
													this.hooks.executeModule.call(
														moduleArgument,
														context
													),
												"Compilation.hooks.executeModule"
											);
											moduleObject.loaded = true;
											return moduleObject.exports;
										} catch (execErr) {
											if (strictModuleExceptionHandling) {
												if (id) delete moduleCache[id];
											} else if (strictModuleErrorHandling) {
												moduleObject.error = execErr;
											}
											if (!execErr.module) execErr.module = module;
											throw execErr;
										}
									};

									for (const runtimeModule of chunkGraph.getChunkRuntimeModulesInOrder(
										chunk
									)) {
										__webpack_require_module__(
											
											(moduleArgumentsMap.get(runtimeModule))
										);
									}
									exports = __webpack_require__(module.identifier());
								} catch (execErr) {
									const err = new WebpackError(
										`Execution of module code from module graph (${module.readableIdentifier(
											this.requestShortener
										)}) failed: ${execErr.message}`
									);
									err.stack = execErr.stack;
									err.module = execErr.module;
									return callback(err);
								}

								callback(null, {
									exports,
									assets,
									cacheable,
									fileDependencies,
									contextDependencies,
									missingDependencies,
									buildDependencies
								});
							}
						);
					});
				});
			}
		);
	}

	checkConstraints() {
		const chunkGraph = this.chunkGraph;

		
		const usedIds = new Set();

		for (const module of this.modules) {
			if (module.type === WEBPACK_MODULE_TYPE_RUNTIME) continue;
			const moduleId = chunkGraph.getModuleId(module);
			if (moduleId === null) continue;
			if (usedIds.has(moduleId)) {
				throw new Error(`checkConstraints: duplicate module id ${moduleId}`);
			}
			usedIds.add(moduleId);
		}

		for (const chunk of this.chunks) {
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!this.modules.has(module)) {
					throw new Error(
						"checkConstraints: module in chunk but not in compilation " +
							` ${chunk.debugId} ${module.debugId}`
					);
				}
			}
			for (const module of chunkGraph.getChunkEntryModulesIterable(chunk)) {
				if (!this.modules.has(module)) {
					throw new Error(
						"checkConstraints: entry module in chunk but not in compilation " +
							` ${chunk.debugId} ${module.debugId}`
					);
				}
			}
		}

		for (const chunkGroup of this.chunkGroups) {
			chunkGroup.checkConstraints();
		}
	}
}
  
/* eslint-disable jsdoc/require-asterisk-prefix */
Compilation.prototype.factorizeModule =  (
	function (options, callback) {
		this.factorizeQueue.add(options, callback);
	}
);
/* eslint-enable jsdoc/require-asterisk-prefix */

// Hide from typescript
const compilationPrototype = Compilation.prototype;

// TODO webpack 6 remove
Object.defineProperty(compilationPrototype, "modifyHash", {
	writable: false,
	enumerable: false,
	configurable: false,
	value: () => {
		throw new Error(
			"Compilation.modifyHash was removed in favor of Compilation.hooks.fullHash"
		);
	}
});

// TODO webpack 6 remove
Object.defineProperty(compilationPrototype, "cache", {
	enumerable: false,
	configurable: false,
	get: util.deprecate( 
		function () {
			// @ts-ignore
			return this.compiler.cache;
		},
		"Compilation.cache was removed in favor of Compilation.getCache()",
		"DEP_WEBPACK_COMPILATION_CACHE"
	),
	set: util.deprecate( 
		v => {},
		"Compilation.cache was removed in favor of Compilation.getCache()",
		"DEP_WEBPACK_COMPILATION_CACHE"
	)
});

 
Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL = -2000;

 
Compilation.PROCESS_ASSETS_STAGE_PRE_PROCESS = -1000;

 
Compilation.PROCESS_ASSETS_STAGE_DERIVED = -200;
 
Compilation.PROCESS_ASSETS_STAGE_ADDITIONS = -100;

 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE = 100;

 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT = 200;
 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY = 300;
 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE = 400;
 
Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING = 500;

 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE = 700;

 
Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE = 1000;
 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH = 2500;

 
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER = 3000;
 
Compilation.PROCESS_ASSETS_STAGE_ANALYSE = 4000;


Compilation.PROCESS_ASSETS_STAGE_REPORT = 5000;

module.exports = Compilation;
