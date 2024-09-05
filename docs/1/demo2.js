let init = false;
function getConfig(){
    if(!init){
        init = true;
        return '配置1'
    }
    return '配置2';
}

module.exports = getConfig;