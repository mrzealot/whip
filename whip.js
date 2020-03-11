#!/usr/bin/env node

const fs = require('fs')
const os = require('os')
const path = require('path')
const open = require('open')
const yaml = require('js-yaml')
const args = require('yargs').argv
const moment = require('moment')
const mkdirp = require('mkdirp')
const readline = require('readline')

let verbose = () => {}

const usage = (msg = '', code = 1) => {
    if (msg) {
        console.log(msg)
        console.log()
    }
    console.log(`Common arguments:`)
    console.log(`  -c/--config: specify the config file to use`)
    console.log(`  -i/--input: specify/override the input file`)
    console.log()
    console.log(`Commands:`)
    console.log(`coin (c)onfig -- list all current config key/value pairs`)
    console.log(`coin (c)onfig key -- print config for a specific key`)
    console.log(`coin (c)onfig key value -- set key to value in the config`)
    console.log()
    console.log(`coin ()(g)enerate -- generate the daily TODO list`)
    console.log(`  --date -- override the date (default: today)`)
    console.log(`  --format -- the path format to the daily logs, see moment.js`)
    console.log(`  --noopen -- don't automatically open in editor`)   
    // TODO console.log(`  --noyesterday -- don't look back to see what's overdue`)    
    process.exit(code)
}






// TODO look back to yesterday's file to see if anything's overdue
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
                return yaml.safeLoad(raw)
            }
            continue
        }

        if (in_yaml) {
            raw += line + '\n'
        }
    }
}



const actual = (when, now_override) => {
    verbose(`Checking if ${when} is actual...`)
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
    
    verbose(`frequency=${frequency}, expander=${num}/${denom}, restrictor=${restrictor}`)

    const now = moment(now_override)
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




class Commander {

    constructor(config, args, lookup) {
        this.aliases = {
            u: 'usage',
            c: 'config',
            g: 'generate'
        }
        this.usage = usage
        const valids = new Set(Object.values(this.aliases))

        this.command = this.aliases[args._[0]] || args._[0]
        if (!this.command) this.command = 'generate'
        if (!valids.has(this.command)) usage(`Unknown command "${command}"`)

        this.config_data = config
        this.args = args
        this.lookup = lookup
    }

    needs_input() {
        return !['usage', 'config'].includes(this.command)
    }

    load(input_file, data) {
        this.input_file = input_file
        this.data = data
    }

    config() {
        const conf = this.config_data
        const [,key,val] = this.args._
        if (key) {
            if (val) {
                conf[key] = val
                fs.writeFileSync(this.args.config, yaml.safeDump(conf))
                verbose(`Successfully set config key "${key}" to value "${val}"`)
            } else {
                console.log(conf[key])
            }
        } else {
            console.log(conf)
        }
    }

    generate() {
        const format = this.lookup('format')
        const now_override = this.lookup('date')
        if (!format) usage('Missing format...')

        let header = {}
        for (const group of this.data) {
            for (const task of group.subs) {
                if (actual(task.when, now_override)) {
                    header[group.name] = header[group.name] || {}
                    header[group.name][task.name] = ''
                }
            }
        }

        const now = moment(now_override)
        const content = `---\n${yaml.safeDump(header)}---\n\n# ${now.format('dddd')} Notes:\n\n- `
        const file = now.format(format)
        if (fs.existsSync(file) && !this.lookup('force')) {
            console.log(`File ${file} already exists, so you have to --force this!`)
        }

        mkdirp.sync(path.dirname(file))
        fs.writeFileSync(file, content)

        if (!this.lookup('noopen')) open(file)
    }

    execute() {
        return this[this.command]()
    }
}




;(async () => {

    // logging (if necessary)
    if (args.v || args.verbose) {
        verbose = console.log.bind(console)
    }

    // set up config
    args.config = args.config || args.c
    if (!args.config) {
        args.config = path.join(os.homedir(), '.whip_config')
    }
    if (!fs.existsSync(args.config)) {
        verbose(`Initializing config file at ${args.config}`)
        mkdirp.sync(path.dirname(args.config))
        fs.writeFileSync(args.config, yaml.safeDump({}))
    }
    verbose(`Loading config from ${args.config}`)
    const config = yaml.safeLoad(fs.readFileSync(args.config, 'utf8'))

    const lookup = ((config, args) => (key) => {
        if (!Array.isArray(key)) {
            key = [key]
        }
        for (const k of key) {
            if (args[k]) return args[k]
            if (config[k]) return config[k]
        }
        return undefined
    })(config, args)

    // setting up the commander
    const commander = new Commander(config, args, lookup)
    if (commander.needs_input()) {
        // parse input
        const input = lookup(['input', 'i'])
        if (!input) usage('Missing input...')
        verbose(`Parsing input ${input}`)
        const data = yaml.safeLoad(fs.readFileSync(input, 'utf8'))
        commander.load(input, data)
    }

    // execute command
    verbose(`Executing command ${commander.command}`)
    commander.execute()

})()