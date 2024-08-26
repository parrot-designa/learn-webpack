 
"use strict";

const DelegatedModule = require("./DelegatedModule");
 
 

class DelegatedModuleFactoryPlugin {
	 
	constructor(options) {
		this.options = options;
		options.type = options.type || "require";
		options.extensions = options.extensions || ["", ".js", ".json", ".wasm"];
	} 

	apply(normalModuleFactory) {
		const scope = this.options.scope;
		if (scope) {
			normalModuleFactory.hooks.factorize.tapAsync(
				"DelegatedModuleFactoryPlugin",
				(data, callback) => {
					const [dependency] = data.dependencies;
					const { request } = dependency;
					if (request && request.startsWith(`${scope}/`)) {
						const innerRequest = `.${request.slice(scope.length)}`;
						let resolved;
						if (innerRequest in this.options.content) {
							resolved = this.options.content[innerRequest];
							return callback(
								null,
								new DelegatedModule(
									this.options.source,
									resolved,
									 (this.options.type),
									innerRequest,
									request
								)
							);
						}
						const extensions =
							
							(this.options.extensions);
						for (let i = 0; i < extensions.length; i++) {
							const extension = extensions[i];
							const requestPlusExt = innerRequest + extension;
							if (requestPlusExt in this.options.content) {
								resolved = this.options.content[requestPlusExt];
								return callback(
									null,
									new DelegatedModule(
										this.options.source,
										resolved,
										 (this.options.type),
										requestPlusExt,
										request + extension
									)
								);
							}
						}
					}
					return callback();
				}
			);
		} else {
			normalModuleFactory.hooks.module.tap(
				"DelegatedModuleFactoryPlugin",
				module => {
					const request = module.libIdent(this.options);
					if (request && request in this.options.content) {
						const resolved = this.options.content[request];
						return new DelegatedModule(
							this.options.source,
							resolved,
							 (this.options.type),
							request,
							module
						);
					}
					return module;
				}
			);
		}
	}
}
module.exports = DelegatedModuleFactoryPlugin;
