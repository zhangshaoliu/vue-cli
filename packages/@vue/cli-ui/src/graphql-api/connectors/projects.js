const path = require('path')
const fs = require('fs')
const shortId = require('shortid')
const Creator = require('@vue/cli/lib/Creator')
const { getPromptModules } = require('@vue/cli/lib/util/createTools')
const { getFeatures } = require('@vue/cli/lib/util/features')
const { defaults } = require('@vue/cli/lib/options')
const { toShortPluginId } = require('@vue/cli-shared-utils')
const { progress: installProgress } = require('@vue/cli/lib/util/installDeps')
// Connectors
const progress = require('./progress')
const cwd = require('./cwd')
const prompts = require('./prompts')
const folders = require('./folders')
const plugins = require('./plugins')
const locales = require('./locales')
// Context
const getContext = require('../context')
// Utils
const { log } = require('../utils/logger')
const { notify } = require('../utils/notification')

const PROGRESS_ID = 'project-create'

let lastProject = null
let currentProject = null
let creator = null
let presets = []
let features = []
let onCreationEvent = null
let onInstallProgress = null
let onInstallLog = null

function list (context) {
  let projects = context.db.get('projects').value()
  projects = autoClean(projects, context)
  return projects
}

function autoClean (projects, context) {
  let result = []
  for (const project of projects) {
    if (fs.existsSync(project.path)) {
      result.push(project)
    }
  }
  if (result.length !== projects.length) {
    console.log(`Auto cleaned ${projects.length - result.length} projects (folder not found).`)
    context.db.set('projects', result).write()
  }
  return result
}

function getCurrent (context) {
  if (currentProject && !fs.existsSync(currentProject.path)) {
    log('Project folder not found', currentProject.id, currentProject.path)
    return null
  }
  return currentProject
}

function getLast (context) {
  return lastProject
}

function generatePresetDescription (preset) {
  let description = preset.features.join(', ')
  if (preset.raw.useConfigFiles) {
    description += ` (Use config files)`
  }
  return description
}

function generateProjectCreation (creator) {
  return {
    presets,
    features,
    prompts: prompts.list()
  }
}

async function initCreator (context) {
  const creator = new Creator('', cwd.get(), getPromptModules())

  /* Event listeners */
  // Creator emits creation events (the project creation steps)
  onCreationEvent = ({ event }) => {
    progress.set({ id: PROGRESS_ID, status: event, info: null }, context)
  }
  creator.on('creation', onCreationEvent)
  // Progress bar
  onInstallProgress = value => {
    if (progress.get(PROGRESS_ID)) {
      progress.set({ id: PROGRESS_ID, progress: value }, context)
    }
  }
  installProgress.on('progress', onInstallProgress)
  // Package manager steps
  onInstallLog = message => {
    if (progress.get(PROGRESS_ID)) {
      progress.set({ id: PROGRESS_ID, info: message }, context)
    }
  }
  installProgress.on('log', onInstallLog)

  // Presets
  const manualPreset = {
    id: '__manual__',
    name: 'views.project-create.tabs.presets.manual.name',
    description: 'views.project-create.tabs.presets.manual.description',
    link: null,
    features: []
  }
  const presetsData = creator.getPresets()
  presets = [
    ...Object.keys(presetsData).map(
      key => {
        const preset = presetsData[key]
        const features = getFeatures(preset).map(
          f => toShortPluginId(f)
        )
        const info = {
          id: key,
          name: key === 'default' ? 'views.project-create.tabs.presets.default-preset' : key,
          features,
          link: null,
          raw: preset
        }
        info.description = generatePresetDescription(info)
        return info
      }
    ),
    manualPreset
  ]

  // Features
  const featuresData = creator.featurePrompt.choices
  features = [
    ...featuresData.map(
      data => ({
        id: data.value,
        name: data.name,
        description: data.description || null,
        link: data.link || null,
        plugins: data.plugins || null,
        enabled: !!data.checked
      })
    ),
    {
      id: 'use-config-files',
      name: 'views.project-create.tabs.features.userConfigFiles.name',
      description: 'views.project-create.tabs.features.userConfigFiles.description',
      link: null,
      plugins: null,
      enabled: false
    }
  ]

  manualPreset.features = features.filter(
    f => f.enabled
  ).map(
    f => f.id
  )

  // Prompts
  await prompts.reset()
  creator.injectedPrompts.forEach(prompts.add)
  await updatePromptsFeatures()
  await prompts.start()

  return creator
}

function removeCreator (context) {
  if (creator) {
    creator.removeListener('creation', onCreationEvent)
    installProgress.removeListener('progress', onInstallProgress)
    installProgress.removeListener('log', onInstallLog)
    creator = null
  }
}

async function getCreation (context) {
  if (!creator) {
    creator = await initCreator(context)
  }
  return generateProjectCreation(creator)
}

async function updatePromptsFeatures () {
  await prompts.changeAnswers(answers => {
    answers.features = features.filter(
      f => f.enabled
    ).map(
      f => f.id
    )
  })
}

async function setFeatureEnabled ({ id, enabled, updatePrompts = true }, context) {
  const feature = features.find(f => f.id === id)
  if (feature) {
    feature.enabled = enabled
  } else {
    console.warn(`Feature '${id}' not found`)
  }
  if (updatePrompts) await updatePromptsFeatures()
  return feature
}

async function applyPreset (id, context) {
  const preset = presets.find(p => p.id === id)
  if (preset) {
    for (const feature of features) {
      feature.enabled = !!(
        preset.features.includes(feature.id) ||
        (feature.plugins && preset.features.some(f => feature.plugins.includes(f)))
      )
    }
    if (preset.raw) {
      if (preset.raw.router) {
        await setFeatureEnabled({ id: 'router', enabled: true, updatePrompts: false }, context)
      }
      if (preset.raw.vuex) {
        await setFeatureEnabled({ id: 'vuex', enabled: true, updatePrompts: false }, context)
      }
      if (preset.raw.cssPreprocessor) {
        await setFeatureEnabled({ id: 'css-preprocessor', enabled: true, updatePrompts: false }, context)
      }
      if (preset.raw.useConfigFiles) {
        await setFeatureEnabled({ id: 'use-config-files', enabled: true, updatePrompts: false }, context)
      }
    }
    await updatePromptsFeatures()
  } else {
    console.warn(`Preset '${id}' not found`)
  }

  return generateProjectCreation(creator)
}

async function create (input, context) {
  return progress.wrap(PROGRESS_ID, context, async setProgress => {
    setProgress({
      status: 'creating'
    })

    const targetDir = path.join(cwd.get(), input.folder)
    creator.context = targetDir

    const inCurrent = input.folder === '.'
    const name = inCurrent ? path.relative('../', process.cwd()) : input.folder
    creator.name = name

    // Delete existing folder
    if (fs.existsSync(targetDir)) {
      if (input.force) {
        setProgress({
          info: 'Cleaning folder...'
        })
        await folders.delete(targetDir)
        setProgress({
          info: null
        })
      } else {
        throw new Error(`Folder ${targetDir} already exists`)
      }
    }

    // Answers
    const answers = prompts.getAnswers()
    await prompts.reset()
    let index

    // Package Manager
    answers.packageManager = input.packageManager

    // Config files
    if ((index = answers.features.indexOf('use-config-files')) !== -1) {
      answers.features.splice(index, 1)
      answers.useConfigFiles = 'files'
    }

    // Preset
    answers.preset = input.preset
    if (input.save) {
      answers.save = true
      answers.saveName = input.save
    }

    setProgress({
      info: 'Resolving preset...'
    })
    let preset
    if (input.remote) {
      // vue create foo --preset bar
      preset = await creator.resolvePreset(input.preset, input.clone)
    } else if (input.preset === 'default') {
      // vue create foo --default
      preset = defaults.presets.default
    } else {
      preset = await creator.promptAndResolvePreset(answers)
    }
    setProgress({
      info: null
    })

    // Create
    await creator.create({ git: true }, preset)
    removeCreator()

    notify({
      title: `Project created`,
      message: `Project ${cwd.get()} created`,
      icon: 'done'
    })

    return importProject({
      path: targetDir
    }, context)
  })
}

async function importProject (input, context) {
  const project = {
    id: shortId.generate(),
    path: input.path,
    favorite: 0
  }
  const packageData = folders.readPackage(project.path, context)
  project.name = packageData.name
  context.db.get('projects').push(project).write()
  return open(project.id, context)
}

async function open (id, context) {
  const project = context.db.get('projects').find({
    id
  }).value()

  if (!project) {
    log('Project not found', id)
    return null
  }

  if (!fs.existsSync(project.path)) {
    log('Project folder not found', id, project.path)
    return null
  }

  lastProject = currentProject
  currentProject = project
  cwd.set(project.path, context)
  // Reset locales
  locales.reset(context)
  // Load plugins
  plugins.list(project.path, context)

  // Save for next time
  context.db.set('config.lastOpenProject', id).write()

  log('Project open', id, project.path)

  return project
}

async function remove (id, context) {
  if (currentProject && currentProject.id === id) {
    currentProject = null
  }
  context.db.get('projects').remove({ id }).write()
  if (context.db.get('config.lastOpenProject').value() === id) {
    context.db.set('config.lastOpenProject', undefined).write()
  }
  return true
}

function resetCwd (context) {
  if (currentProject) {
    cwd.set(currentProject.path, context)
  }
}

function findOne (id, context) {
  return context.db.get('projects').find({ id }).value()
}

function setFavorite ({ id, favorite }, context) {
  context.db.get('projects').find({ id }).assign({ favorite }).write()
  return findOne(id, context)
}

// Open last project
async function autoOpenLastProject () {
  const context = getContext(null)
  const id = context.db.get('config.lastOpenProject').value()
  if (id) {
    try {
      await open(id, context)
    } catch (e) {
      log(`Project can't be auto-opened`, id)
    }
  }
}

autoOpenLastProject()

module.exports = {
  list,
  getCurrent,
  getLast,
  getCreation,
  applyPreset,
  setFeatureEnabled,
  create,
  import: importProject,
  open,
  remove,
  resetCwd,
  setFavorite
}
