const path = require('path');

module.exports = {
    mode:'production',
    entry:'./src/index.js',
    context: path.resolve(__dirname,'.'),
    output:{
        filename:'bundle.js',
        path:path.resolve('dist')
    }
}