import { PluginOption, normalizePath } from 'vite'
import { InputPluginOption, Plugin, rollup, SourceMap } from 'rollup'
import swc from "@rollup/plugin-swc";
import ts from 'typescript'
import chalk from 'chalk'
import { resolve } from 'path';

type Asyncable<T> = T | Promise<T>

export type ProjectMeta = {
	index: [string, ...string[]],
	projectRootDir: string,
	tsConfigFile?: string,
	buildPlugins?: (plugins: {
		swc: Plugin,
		tsIsExternal: Plugin,
	}) => Asyncable<InputPluginOption[]>
	,
}

export function rollupMonoLoad(opts: ProjectMeta): PluginOption {
	let projectRootDir = opts.projectRootDir
	if (!projectRootDir.endsWith('/')) { projectRootDir = `${projectRootDir}/` }
	const index = opts.index.map((path) => resolve(projectRootDir, path))
	const getPlugins = opts.buildPlugins ?? (({ swc, tsIsExternal }) => [swc, tsIsExternal])
	const tsConfigFile = opts.tsConfigFile
	const cache: Map<string, {
		code: string,
		map: SourceMap,
		refresh: () => Promise<void>,
	}> = new Map()
	const refreshCb = async (opts: {
		addWatchFile: (id: string) => void,
		log: (msg: string) => void
	}) => {
		opts.log(`${chalk.green('[Processing with Rollup]')} building...`);
		const plugins = await getPlugins({
			swc: swc({
				swc: {
					sourceMaps: true,
					jsc: {
						target: 'esnext',
						parser: {
							decorators: true,
							syntax: "typescript",
							tsx: true,
						},
					},
				}
			}),
			tsIsExternal: (() => {
				const configFilePath = ts.findConfigFile(projectRootDir, ts.sys.fileExists, tsConfigFile)
				if (!configFilePath) { throw new Error(`can't find a tsconfig.json`) }
				const parsedCommandLine = ts.getParsedCommandLineOfConfigFile(configFilePath, {
					module: ts.ModuleKind.ESNext,
				}, {
					...ts.sys,
					onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
						throw new Error(diagnostic.messageText.toString())
					}
				})
				if (!parsedCommandLine) { throw new Error() }
				if (parsedCommandLine.errors.length !== 0) {
					throw new Error(parsedCommandLine.errors.map((e) => e.messageText.toString()).join('\n\n'))
				}
				return {
					name: 'resolve-external-file',
					resolveId: (id, importer) => {
						if (!importer) { return null }
						const { resolvedModule } = ts.resolveModuleName(id, importer, parsedCommandLine.options, ts.sys)
						if (resolvedModule && !resolvedModule.isExternalLibraryImport) {
							const resultId = normalizePath(resolvedModule.resolvedFileName)
							return {
								external: false,
								id: resultId,
							}
						}
						return {
							id,
							external: true
						}
					}
				}
			})()
		})
		const bundle = await rollup({
			input: index,
			treeshake: {
				moduleSideEffects: false,
			},
			plugins,
		})
		const r = await bundle.generate({
			'format': 'esm',
			'sourcemap': 'hidden',
			preserveModules: true,
		})
		let refresh$ = null
		r.output.forEach((chunk) => {
			if (chunk.type !== 'chunk') { return }
			const sourceId = normalizePath(chunk.facadeModuleId!)
			opts.log(`${chalk.green('[rollup build success]')} ${chalk.blue(sourceId)}`);
			opts.addWatchFile(sourceId)
			cache.set(sourceId, {
				code: chunk.code,
				map: chunk.map!,
				refresh: () => {
					refresh$ ??= refreshCb(opts)
					return refresh$
				}
			})
		})
	}
	return {
		'name': 'mono-load',
		async load(id) {
			if (!id.startsWith(projectRootDir)) { return }
			const fileId = new URL(id).pathname.slice(1)
			if (!cache.has(fileId)) {
				await refreshCb({
					addWatchFile: (id) => this.addWatchFile(id),
					log: this.environment.mode === 'build' ? () => { } : (msg) => console.log(msg)
				})
			}
			const saved = cache.get(fileId)!
			return {
				code: saved.code,
				map: saved.map,
			}
		},
		async watchChange(id, x) {
			if (x.event !== 'update') { return }
			if (!id.startsWith(projectRootDir)) { return }
			await cache.get(id)?.refresh()
		}
	}
}