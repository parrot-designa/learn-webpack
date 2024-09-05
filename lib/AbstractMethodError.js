/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Ivan Kopeykin @vankop
*/

"use strict";

const WebpackError = require("./WebpackError");
const CURRENT_METHOD_REGEXP = /at ([a-zA-Z0-9_.]*)/;

 
function createMessage(method) {
	return `Abstract method${method ? ` ${method}` : ""}. Must be overridden.`;
}
 
function Message() { 
	this.stack = undefined;
	Error.captureStackTrace(this);
	const match = 
		// @ts-ignore
		this.stack
			.split("\n")[3]
			.match(CURRENT_METHOD_REGEXP);

	this.message = match && match[1] ? createMessage(match[1]) : createMessage();
}
 
class AbstractMethodError extends WebpackError {
	constructor() {
		super(new Message().message);
		this.name = "AbstractMethodError";
	}
}

module.exports = AbstractMethodError;
