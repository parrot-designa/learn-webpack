/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Jarid Margolin @jaridmargolin
*/

"use strict";

const inspect = require("util").inspect.custom;
const makeSerializable = require("./util/makeSerializable");
 
class WebpackError extends Error { 
	constructor(message) {
		super(message);
 
		this.details = undefined; 
		this.module = undefined; 
		this.loc = undefined; 
		this.hideStack = undefined; 
		this.chunk = undefined; 
		this.file = undefined;
	}

	[inspect]() {
		return this.stack + (this.details ? `\n${this.details}` : "");
	}
 
	serialize({ write }) {
		write(this.name);
		write(this.message);
		write(this.stack);
		write(this.details);
		write(this.loc);
		write(this.hideStack);
	}
 
	deserialize({ read }) {
		this.name = read();
		this.message = read();
		this.stack = read();
		this.details = read();
		this.loc = read();
		this.hideStack = read();
	}
}

makeSerializable(WebpackError, "webpack/lib/WebpackError");

module.exports = WebpackError;
