#!/usr/bin/env node
// 入口只做转发：钩子路径要尽量快，不在这里加任何多余的 import
import { main } from '../src/cli.js';
main(process.argv.slice(2)).then((code) => process.exit(code ?? 0), () => process.exit(0));
