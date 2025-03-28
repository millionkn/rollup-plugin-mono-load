import { PluginOption, normalizePath } from 'vite'
import { InputPluginOption, Plugin, rollup, SourceMap } from 'rollup'
import swc from "@rollup/plugin-swc";
import ts from 'typescript'
import chalk from 'chalk'

type Asyncable<T> = T | Promise<T>

export type ProjectMeta = {
	index?: [string, ...string[]],
	projectRootDir: string,
	tsConfigFile?: string,
	buildPlugins?: (plugins: {
		swc: Plugin,
		tsIsExternal: Plugin,
	}) => Asyncable<InputPluginOption[]>
	,
}

export function rollupMonoLoad(
	isMonoProject: (fileId: string) => false | Asyncable<ProjectMeta>,
): PluginOption {
	const cache: Map<string, {
		code: string,
		map: SourceMap,
		refresh: () => Promise<void>,
	}> = new Map()
	const refreshCb = async (index: [string, ...string[]], projectMeta: ProjectMeta, addWatchFile: (id: string) => void) => {
		console.log(`${chalk.green('[Processing with Rollup]')} ${index.length} index file...`);
		const getPlugins = projectMeta.buildPlugins ?? (({ swc, tsIsExternal }) => [swc, tsIsExternal])
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
				const configFilePath = ts.findConfigFile(projectMeta.projectRootDir, ts.sys.fileExists, projectMeta.tsConfigFile)
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
			console.log(`${chalk.green('[rollup build success]')} ${chalk.blue(sourceId)}`);
			addWatchFile(sourceId)
			cache.set(sourceId, {
				code: chunk.code,
				map: chunk.map!,
				refresh: () => {
					refresh$ ??= refreshCb(index, projectMeta, addWatchFile)
					return refresh$
				}
			})
		})
	}
	return {
		'name': 'mono-load',
		async load(_id) {
			const url = new URL(`file://${_id}`)
			const id = decodeURIComponent(url.pathname.slice(1))
			const projectMeta = await isMonoProject(id)
			if (!projectMeta) { return }
			if (!cache.has(id)) {
				await refreshCb(projectMeta.index ?? [id], projectMeta, (id) => this.addWatchFile(id))
			}
			const saved = cache.get(id)!
			return {
				code: saved.code,
				map: saved.map,
			}
		},
		async watchChange(id, x) {
			if (x.event !== 'update') { return }
			const isMono = !!await isMonoProject(id)
			if (!isMono) { return }
			await cache.get(id)?.refresh()
		}
	}
}