#!/usr/bin/env node

//#region Includes

const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const open = require('open')
const yaml = require('js-yaml')
const moment = require('moment')
const readline = require('readline')

//#endregion

//#region Helpers

const actual = (when, now) => {
    let [frequency, expander, restrictor] = when.split(/\s+/g)

    if (!expander || !expander.includes('/')) {
        restrictor = expander
        expander = '1/1'
    }

    let [num, denom] = expander.split('/')
    if (isNaN(num) || isNaN(denom)) {
        throw new Error('Expander has to be formatted num/denom, where both num and denom are valid integers!')
    }
    num = parseInt(num)
    denom = parseInt(denom)

    if (num > denom) {
        throw new Error(`Expander num (${num}) > denom (${denom}), which will never happen!`)
    }

    if (restrictor) {
        restrictor = restrictor.trim().split(',')
    } else {
        restrictor = []
    }
    
    const weekEpoch = moment('1970-01-05 00:00:00')
    const monthEpoch = moment('1970-01-01 00:00:00')
    let epoch
    let unit

    if (frequency == 'daily') {
        if (restrictor.length) {
            throw new Error(`Frequency is daily already, what are you trying to restrict? (${restrictor})`)
        }
        epoch = monthEpoch
        unit = 'days'


    } else if (frequency == 'weekly') {
        if (!restrictor.length) {
            throw new Error(`Weekly WHAT?!`)
        }
        const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
        if (restrictor.some(r => !days.includes(r))) {
            throw new Error(`Weekly WHAT?! (${restrictor})`)
        }
        const day = days[now.day()]
        if (!restrictor.includes(day)) return false
        epoch = weekEpoch
        unit = 'weeks'


    } else if (frequency == 'monthly') {
        if (!restrictor.length) {
            throw new Error(`Monthly WHAT?!`)
        }
        // handle "last" for monthly restrictions
        const index = restrictor.indexOf('last')
        if (index !== -1) {
            restrictor[index] = now.endOf('month').date()
        }
        if (restrictor.some(r => !r.match(/^\d\d$/))) {
            throw new Error(`Monthly WHAT?! (${restrictor})`)
        }
        if (!restrictor.includes(now.format('DD'))) return false
        epoch = monthEpoch
        unit = 'months'


    } else if (frequency == 'yearly') {
        if (!restrictor.length) {
            throw new Error(`Yearly WHAT?!`)
        }
        if (restrictor.some(r => !r.match(/^\d\d-\d\d$/))) {
            throw new Error(`Yearly WHAT?! (${restrictor})`)
        }
        if (!restrictor.includes(now.format('MM-DD'))) return false
        epoch = monthEpoch
        unit = 'years'


    } else {
        throw new Error(`Unrecognized frequency: ${frequency}!`)
    }

    const diff = moment().diff(epoch, unit)
    const mod = (diff % denom) + 1
    if (mod != num) return false

    return true
}

const parse = async (file) => {
    let raw = ''
    let in_yaml = false

    const rl = readline.createInterface({
        input: fs.createReadStream(file)
    })
    
    for await (const line of rl) {
        if (line.trim() == '---') {
            in_yaml = !in_yaml
            if (!in_yaml) {
                try {
                    return yaml.safeLoad(raw)
                } catch (ex) {
                    throw new Error(`Failed to parse ${file}`, ex)
                }
            }
            continue
        }

        if (in_yaml) {
            raw += line + '\n'
        }
    }
}

const input = (file) => {
    if (!file) throw new Error('Missing input parameter...')
    if (!fs.existsSync(file)) throw new Error('Non-existent input file')
    return yaml.safeLoad(fs.readFileSync(file, 'utf8'))
}

//#endregion

//#region Commands

let config = {} 

require('yargs')
.option('config', {
    alias: 'c',
    default: path.join(os.homedir(), '.whip_config'),
    describe: 'Config yaml file',
    type: 'string'
})
.config('config', (path) => {
    if (!fs.existsSync(path)) {
        console.log(`Initializing config file at ${path}`)
        fs.mkdirpSync(path.dirname(path))
        fs.writeFileSync(path, yaml.safeDump({}))
    }
    return config = yaml.safeLoad(fs.readFileSync(path, 'utf8'))
})
.option('input', {
    alias: 'i',
    describe: 'Input schedule file',
    type: 'string'
})
.option('verbose', {
    alias: 'v',
    default: false,
    describe: 'Verbose log output',
    type: 'boolean'
})
.command(['config [key] [value]', 'c'], 'Get or set config parameters', {}, (args) => {
    if (args.key) {
        if (args.value !== undefined) {
            if (args.value == 'true' || args.value == 'yes') args.value = true
            if (args.value == 'false' || args.value == 'no') args.value = false
            config[args.key] = args.value
            if (args.value == 'undefined') delete config[args.key]
            fs.writeFileSync(args.config, yaml.safeDump(config))
            console.log(`Successfully set config key "${args.key}" to value "${args.value}"`)
        } else {
            console.log(config[args.key])
        }
    } else {
        console.log(config)
    }
})
.command(['generate', 'g', '*'], 'Generate a daily TODO list', (yargs) => {
    return yargs
    .option('date', {
        alias: 'd',
        describe: 'Override date (default is today)',
        type: 'string'
    })
    .option('format', {
        alias: 'f',
        default: '',
        describe: 'Path format to daily log file',
        type: 'string'
    })
    .option('yesterday', {
        default: true,
        describe: 'Whether to look back to yesterday\'s file to see if anything\'s overdue',
        type: 'boolean'
    })
    .option('force', {
        default: false,
        describe: 'Whether to force (re)generation of existing file',
        type: 'boolean'
    })
    .option('open', {
        default: true,
        describe: 'Whether to open the newly generated file in the default editor',
        type: 'boolean'
    })
}, async (args) => {
    if (!args.input) throw new Error('Missing input...')
    if (!args.format) throw new Error('Missing format...')
    if (!args.date) args.date = undefined
    const now = moment(args.date)

    const input_data = input(args.input)
    let header = {}
    for (const group of input_data) {
        for (const task of group.subs) {
            if (actual(task.when, now)) {
                header[group.name] = header[group.name] || {}
                header[group.name][task.name] = ''
            }
        }
    }

    if (args.yesterday) {
        const yesterday = moment(now).subtract(1, 'day')
        const old_log = yesterday.format(args.format)
        const old_data = await parse(old_log)
        for (const [group_key, group] of Object.entries(old_data)) {
            for (const [key, val] of Object.entries(group)) {
                if (!val || val == 'no') { // 'no' check added for YAML 1.1 compat
                    header[group_key] = header[group_key] || {}
                    header[group_key][key] = ''
                }
            }
        }
    }

    const content = `---\n${yaml.safeDump(header)}---\n\n# ${now.format('dddd')} Notes:\n\n- `
    const file = now.format(args.format)
    if (fs.existsSync(file) && !args.force) {
        console.log(`File ${file} already exists, so you have to --force this!`)
    } else {
        fs.mkdirpSync(path.dirname(file))
        fs.writeFileSync(file, content)
    }

    if (args.open) open(file)
})
.command(['stats', 'stat', 's'], 'Generate stats from past TODOs', (yargs) => {
    return yargs
    .option('from', {
        alias: 'f',
        describe: 'Stat start date (default = a month ago)',
        type: 'string'
    })
    .option('to', {
        alias: 't',
        describe: 'Stat end date (default = today)',
        type: 'string'
    })
    .option('output', {
        alias: 'o',
        default: 'stats.csv',
        describe: 'Output CSV file',
        type: 'string'
    })
    .option('open', {
        default: true,
        describe: 'Whether to open the newly generated stats in the default viewer',
        type: 'boolean'
    })
}, async (args) => {
    if (!args.format) throw new Error('Missing format...')

    const from = moment(args.from)
    if (!args.from) from.subtract(1, 'month')
    const to = moment(args.to)

    const input_data = input(args.input)
    let labels = {}
    for (const group of input_data) {
        for (const task of group.subs) {
            labels[group.name] = labels[group.name] || []
            labels[group.name].push(task.name)
        }
    }

    let result = [['date']]
    for (const [group_key, group] of Object.entries(labels)) {
        for (const key of group) {
            result[0].push(`${group_key}-${key}`)
        }
    }

    while (from.isBefore(to)) {
        const file = from.format(args.format)
        const data = await parse(file)
        const row = [from.format('YYYY-MM-DD')]
        for (const [group_key, group] of Object.entries(labels)) {
            for (const key of group) {
                let val = data[group_key] ? data[group_key][key] : ''
                val = val ? `"${val}"` : val
                row.push(val)
            }
        }
        result.push(row)
        from.add(1, 'day')
    }

    const result_text = result.map(row => row.join(',')).join('\n')
    fs.writeFileSync(args.output, result_text)
    if (args.open) open(args.output)
})
.demandCommand()
.argv
    
//#endregion
