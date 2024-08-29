# Compiler类

## 一、hooks.beforeRun钩子  AsyncSeriesHook类型

### ProgressPlugin

展示进度条。

* NodeEnvironmentPlugin 

在钩子中这段代码的作用是在 Webpack 编译开始之前，检查是否应该清理输入文件系统的缓存。如果条件符合（即使用的文件系统与预先定义的相同，并且该文件系统支持 purge 操作），则会清理缓存，并记录开始清理的时间点。确保 Webpack 在每次构建时都能读取到最新的文件内容，而不是依赖于旧的缓存。可以避免因缓存导致的问题，例如使用了过期的文件版本。

## 二、hooks.run钩子 AsyncSeriesHook类型

* ProgressPlugin

## 三、hooks.beforeCompile钩子 AsyncSeriesHook类型

### ProgressPlugin

### LazyCompilationPlugin 

LazyCompilationPlugin 的主要目的是确保在执行实际的 webpack 编译任务之前完成一些必要的异步准备步骤。这有助于避免在编译过程中因资源未准备好而导致的问题。如果 backend 已经准备好，则插件不会执行任何操作，而是立即调用回调函数，允许编译继续进行。

### DllReferencePlugin 

主要目的是在 webpack 开始编译之前读取和解析 DLL 的 manifest 文件，以确保编译过程中可以正确引用预先构建好的 DLL 文件。如果读取或解析过程中出现错误，插件会捕获这些错误并将其记录下来。这样可以确保即使 manifest 文件出现问题，编译过程仍然能够继续进行，而错误信息则可以在后续的处理阶段被访问。

## 四. hooks.compile钩子 SyncHook类型

### ProgressPlugin

### DelegatedPlugin 

主要目的是通过自定义 normalModuleFactory 的行为来影响 webpack 如何处理普通模块。这通常是为了实现特定的编译时需求，例如：

修改模块的加载方式。
添加额外的预处理或后处理步骤。
控制模块的缓存机制。

### DllReferencePlugin 

这段代码的主要目的是告诉 webpack 在构建过程中不要解析指定的模块，而是直接引用一个已经预先构建好的 DLL。这可以减少构建时间和最终输出文件的大小，因为不需要重复打包相同的库。

### ExternalsPlugin 

```js
module.exports = {
  // ...
  plugins: [
    new ExternalsPlugin({
      type: 'var',
      externals: {
        jquery: '$'
      }
    })
  ]
};
```

ExternalsPlugin 的主要目的是告诉 webpack 在构建过程中跳过某些模块的解析和打包，而是直接引用这些模块的外部版本。这可以显著减少最终输出文件的大小，并提高构建效率。这对于那些已经在页面中通过其他方式引入的库特别有用。

## 5. hooks.make钩子 AsyncParallelHook类型

* AutomaticPrefetchPlugin

AutomaticPrefetchPlugin 的主要目的是提高应用的加载性能。它通过在每次编译开始时自动为上一次编译中的模块添加预加载依赖来实现这一点。这样，当用户访问应用时，浏览器可以提前加载这些模块，从而减少首次加载时间。这种技术特别适用于那些有大量模块的应用程序，它可以显著提高用户体验。

* DllEntryPlugin

DllEntryPlugin 帮助定义了 DLL 的入口点，使得 webpack 能够正确地打包这些模块到一个或多个 DLL 文件中。这些 DLL 文件随后可以在其他项目中被引用，以避免重复编译相同的模块，从而加快构建速度并减少最终输出文件的大小。

* DynamicEntryPlugin 

DynamicEntryPlugin 插件能够在 webpack 构建过程中动态地添加入口点，这为开发者提供了更大的灵活性，尤其是在需要根据不同的构建环境或条件来选择性地加载模块时非常有用。

* EntryPlugin 

EntryPlugin 插件能够在 webpack 构建过程中添加入口点，这有助于控制构建过程的起点，特别是当需要动态地或条件性地添加入口点时非常有用。这对于需要根据不同的构建环境或条件来选择性地加载模块的情况尤其重要。

* PrefetchPlugin

通过这种方式，PrefetchPlugin 插件能够在 webpack 构建过程中添加预加载依赖，这有助于优化应用的加载性能，特别是当需要提前加载某些关键模块时非常有用。这对于提高用户体验和减少首次加载时间非常重要。

* ProgressPlugin

* ContainerPlugin

ContainerPlugin 是 Webpack 中用来实现模块联邦的核心插件。它允许你定义哪些模块可以被其他 Webpack 构建所访问，并且可以指定哪些模块是从其他构建中导入的。这种机制非常适合于微前端架构，因为它能够让你在多个项目之间共享代码，同时保持每个项目的独立性和可维护性。

## 6. hooks.thisCompilation 钩子 SyncHook类型

### EnvironmentPlugin 

这段代码的作用是确保在Webpack编译时，如果某个环境变量没有被定义，则会触发一个错误，从而阻止编译过程，并给出相应的提示信息。

### FlagEntryExportAsUsedPlugin

### MultiCompiler

### ProgressPlugin

### WarnDeprecatedOptionPlugin

### WarnNoModeSetPlugin

### ResolverCachePlugin

### ContainerPlugin

### WorkerPlugin

### ModuleChunkFormatPlugin

### ModuleChunkLoadingPlugin

### LazyCompilationPlugin

### SyncModuleIdsPlugin

### ArrayPushCallbackChunkFormatPlugin

### CommonJSChunkFormatPlugin

### ....

## 7. hooks.compilation 钩子 SyncHook类型

## 8. hooks.make钩子 AsyncParallelHook类型

## 9. hooks.finishMake钩子 AsyncSeriesHook类型