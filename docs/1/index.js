const memoize = require('./memoize');

const getNum = memoize(() => require('./demo'));
const getConfig = memoize(() => require('./demo2'));

// 正常情况
console.log(getNum());

// 加载的初始化配置
// 下面2次打印出来的结果都是配置1；
console.log(getConfig())
console.log(getConfig())