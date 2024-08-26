

"use strict";

const parseJson = require("json-parse-even-better-errors");
const DelegatedModuleFactoryPlugin = require("./DelegatedModuleFactoryPlugin");
const ExternalModuleFactoryPlugin = require("./ExternalModuleFactoryPlugin");
const WebpackError = require("./WebpackError");
const DelegatedSourceDependency = require("./dependencies/DelegatedSourceDependency");
const createSchemaValidation = require("./util/create-schema-validation");
const makePathsRelative = require("./util/identifier").makePathsRelative;

const validate = createSchemaValidation(
	require("../schemas/plugins/DllReferencePlugin.check.js"),
	() => require("../schemas/plugins/DllReferencePlugin.json"),
	{
		name: "Dll Reference Plugin",
		baseDataPath: "options"
	}
);

 
class DllReferencePlugin { 
	constructor(options) {
		validate(options);
		this.options = options;
		this._compilationData = new WeakMap();
	}
 
	apply(compiler) {
		compiler.hooks.compilation.tap(
			"DllReferencePlugin",
			(compilation, { normalModuleFactory }) => {
				compilation.dependencyFactories.set(
					DelegatedSourceDependency,
					normalModuleFactory
				);
			}
		);

		compiler.hooks.beforeCompile.tapAsync(
			"DllReferencePlugin",
			(params, callback) => {
				if ("manifest" in this.options) {
					const manifest = this.options.manifest;
					if (typeof manifest === "string") { 
						(compiler.inputFileSystem).readFile(manifest, (err, result) => {
							if (err) return callback(err); 
							const data = {
								path: manifest,
								data: undefined,
								error: undefined
							}; 
							try {
								data.data = parseJson(
									(result).toString("utf-8")
								);
							} catch (parseErr) {
								
								
								const manifestPath = makePathsRelative(
									 (compiler.options.context),
									manifest,
									compiler.root
								);
								data.error = new DllManifestError(
									manifestPath,
									 (parseErr).message
								);
							}
							this._compilationData.set(params, data);
							return callback();
						});
						return;
					}
				}
				return callback();
			}
		);

		compiler.hooks.compile.tap("DllReferencePlugin", params => {
			let name = this.options.name;
			let sourceType = this.options.sourceType;
			let resolvedContent =
				"content" in this.options ? this.options.content : undefined;
			if ("manifest" in this.options) {
				const manifestParameter = this.options.manifest;
				let manifest;
				if (typeof manifestParameter === "string") {
					const data =
						
						(this._compilationData.get(params));
					
					
					
					if (data.error) {
						return;
					}
					manifest = data.data;
				} else {
					manifest = manifestParameter;
				}
				if (manifest) {
					if (!name) name = manifest.name;
					if (!sourceType) sourceType = manifest.type;
					if (!resolvedContent) resolvedContent = manifest.content;
				}
			}
			
			const externals = {};
			const source = `dll-reference ${name}`;
			externals[source] =  (name);
			const normalModuleFactory = params.normalModuleFactory;
			new ExternalModuleFactoryPlugin(sourceType || "var", externals).apply(
				normalModuleFactory
			);
			new DelegatedModuleFactoryPlugin({
				source,
				type: this.options.type,
				scope: this.options.scope,
				context:
					
					(this.options.context || compiler.options.context),
				content:
					
					(resolvedContent),
				extensions: this.options.extensions,
				associatedObjectForCache: compiler.root
			}).apply(normalModuleFactory);
		});

		compiler.hooks.compilation.tap(
			"DllReferencePlugin",
			(compilation, params) => {
				if ("manifest" in this.options) {
					const manifest = this.options.manifest;
					if (typeof manifest === "string") {
						const data =  (
							this._compilationData.get(params)
						);
						
						
						if (data.error) {
							compilation.errors.push(
								 (data.error)
							);
						}
						compilation.fileDependencies.add(manifest);
					}
				}
			}
		);
	}
}

class DllManifestError extends WebpackError {
	constructor(filename, message) {
		super();

		this.name = "DllManifestError";
		this.message = `Dll manifest ${filename}\n${message}`;
	}
}

module.exports = DllReferencePlugin;
