/*
	MIT License http://www.opensource.org/licenses/mit-license.php
*/

"use strict";
const memoize = fn => {
	let cache = false; 
	let result;
	return () => {
		if (cache) {
			return  result;
		}

		result = fn();
		cache = true;
		fn = undefined;
		return result;
	};
};

module.exports = memoize;
