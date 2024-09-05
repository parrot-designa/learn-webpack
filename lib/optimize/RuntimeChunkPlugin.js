/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict"; 

class RuntimeChunkPlugin { 
	constructor(options) {
		this.options = { 
			name: entrypoint => `runtime~${entrypoint.name}`,
			...options
		};
	}
 
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("RuntimeChunkPlugin", compilation => {
			compilation.hooks.addEntry.tap(
				"RuntimeChunkPlugin",
				(_, { name: entryName }) => {
					if (entryName === undefined) return;
					const data = 
						(compilation.entries.get(entryName));
					if (data.options.runtime === undefined && !data.options.dependOn) {
					 
						let name = (this.options.name);
						if (typeof name === "function") {
							name = name({ name: entryName });
						}
						data.options.runtime = name;
					}
				}
			);
		});
	}
}

module.exports = RuntimeChunkPlugin;
