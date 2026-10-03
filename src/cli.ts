#!/usr/bin/env node
/// <reference types="node" />
import { run } from './cli/run.js'

process.exitCode = await run(process.argv.slice(2))
