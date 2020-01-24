/*--------------------------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See https://go.microsoft.com/fwlink/?linkid=2090316 for license information.
 *-------------------------------------------------------------------------------------------------------------*/

const os = require('os');
const path = require('path');
const asyncUtils = require('./async');
const jsonc = require('jsonc').jsonc;
const config = require('../../config.json');

config.definitionDependencies = config.definitionDependencies || {};
config.definitionBuildSettings = config.definitionBuildSettings || {};

const stagingFolders = {};
const definitionTagLookup = {};

// Must be called first
async function loadConfig(repoPath) {
    repoPath = repoPath || path.join(__dirname, '..', '..', '..');

    const containersPath = path.join(repoPath, getConfig('containersPathInRepo', 'containers'));
    const definitions = await asyncUtils.readdir(containersPath, { withFileTypes: true });
    await asyncUtils.forEach(definitions, async (definitionFolder) => {
        if (!definitionFolder.isDirectory()) {
            return;
        }
        const definitionId = definitionFolder.name;
        const possibleDefinitionBuildJson = path.join(containersPath, definitionId, getConfig('definitionBuildConfigFile', 'definition-build.json'));
        if (await asyncUtils.exists(possibleDefinitionBuildJson)) {
            const buildJson = await jsonc.read(possibleDefinitionBuildJson);
            if (buildJson.build) {
                config.definitionBuildSettings[definitionId] = buildJson.build;
            }
            if (buildJson.dependencies) {
                config.definitionDependencies[definitionId] = buildJson.dependencies;
            }
        }
    });

    // Populate tag lookup
    for (let definitionId in config.definitionBuildSettings) {
        if (config.definitionBuildSettings[definitionId].tags) {
            const blankTagList = getTagsForVersion(definitionId, '', 'ANY', 'ANY');
            blankTagList.forEach((blankTag) => {
                definitionTagLookup[blankTag] = definitionId;
            });
            const devTagList = getTagsForVersion(definitionId, 'dev', 'ANY', 'ANY');
            devTagList.forEach((devTag) => {
                definitionTagLookup[devTag] = definitionId;
            });
        }
    }
}

// Get a value from the config file or a similarly named env var
function getConfig(property, defaultVal) {
    defaultVal = defaultVal || null;
    // Generate env var name from property - camelCase to CAMEL_CASE
    const envVar = property.split('').reduce((prev, next) => {
        if (next >= 'A' && next <= 'Z') {
            return prev + '_' + next;
        } else {
            return prev + next.toLocaleUpperCase();
        }
    }, '');

    return process.env[envVar] || config[property] || defaultVal;
}


// Convert a release string (v1.0.0) or branch (master) into a version
function getVersionFromRelease(release) {
    // Already is a version
    if (!isNaN(parseInt(release.charAt(0)))) {
        return release;
    }

    // Is a release string
    if (release.charAt(0) === 'v' && !isNaN(parseInt(release.charAt(1)))) {
        return release.substr(1);
    }

    // Is a branch
    return 'dev';
}

// Look up distro and fallback to debian if not specified
function getLinuxDistroForDefinition(definitionId) {
    return config.definitionBuildSettings[definitionId].rootDistro || 'debian';
}

// Generate 'latest' flavor of a given definition's tag
function getLatestTag(definitionId, registry, registryPath) {
    if (typeof config.definitionBuildSettings[definitionId] === 'undefined') {
        return null;
    }
    return config.definitionBuildSettings[definitionId].tags.reduce((list, tag) => {
        list.push(`${registry}/${registryPath}/${tag.replace(/:.+/, ':latest')}`);
        return list;
    }, []);

}

// Create all the needed variants of the specified version identifier for a given definition
function getTagsForDefinition(definitionId, registry, registryPath) {
    if (typeof config.definitionBuildSettings[definitionId] === 'undefined') {
        return null;
    }
    return getTagsForVersion(definitionId, config.definitionBuildSettings[definitionId].version, registry, registryPath)
}

// Create all the needed variants of the specified version identifier for a given definition
function getTagsForVersion(definitionId, version, registry, registryPath) {
    if (typeof config.definitionBuildSettings[definitionId] === 'undefined') {
        return null;
    } 

    return config.definitionBuildSettings[definitionId].tags.reduce((list, tag) => {
        // First see if this version has already been published to the image registry
        const imageRepository = tag.replace(/:.*/, '');
        if() {
            
        }


        // One of the tags that needs to be supported is one where there is no version, but there
        // are other attributes. For example, python:3 in addition to python:0.35.0-3. So, a version
        // of '' is allowed. However, there are also instances that are just the version, so in 
        // these cases latest would be used instead. However, latest is passed in separately.
        const baseTag = tag.replace('${VERSION}', version).replace(':-', ':');
        if (baseTag.charAt(baseTag.length - 1) !== ':') {
            list.push(`${registry}/${registryPath}/${baseTag}`);
        }
        return list;
    }, []);
}

// Generate complete list of tags for a given definition
function getTagList(definitionId, release, updateLatest, registry, registryPath) {
    const version = getVersionFromRelease(release);
    if (version === 'dev') {
        return getTagsForVersion(definitionId, 'dev', registry, registryPath);
    }

    const versionParts = version.split('.');
    if (versionParts.length !== 3) {
        throw (`Invalid version format in ${version}.`);
    }

    const versionList = updateLatest ? [
        version,
        `${versionParts[0]}.${versionParts[1]}`,
        `${versionParts[0]}`,
        '' // This is the equivalent of latest for qualified tags- e.g. python:3 instead of python:0.35.0-3
    ] : [
            version,
            `${versionParts[0]}.${versionParts[1]}`
        ];

    // If this variant should actually be the latest tag, use it
    let tagList = (updateLatest && config.definitionBuildSettings[definitionId].latest) ? getLatestTag(definitionId, registry, registryPath) : [];
    versionList.forEach((tagVersion) => {
        tagList = tagList.concat(getTagsForVersion(definitionId, tagVersion, registry, registryPath));
    });

    return tagList;
}

// Walk the image build config and sort list so parents build before children
function getSortedDefinitionBuildList() {
    const sortedList = [];
    const settingsCopy = JSON.parse(JSON.stringify(config.definitionBuildSettings));

    for (let definitionId in config.definitionBuildSettings) {
        const add = (defId) => {
            if (typeof settingsCopy[defId] === 'object') {
                add(settingsCopy[defId].parent);
                sortedList.push(defId);
                settingsCopy[defId] = undefined;
            }
        }
        add(definitionId);
    }

    return sortedList;
}

function getParentTagForDefinition(definitionId, registry, registryPath) {
    const parentId = config.definitionBuildSettings[definitionId].parent;
    return parentId ? getTagsForDefinition(parentId, registry, registryPath)[0] : null;
}


// Get parent tag for a given child definition
function getParentTagForVersion(definitionId, version, registry, registryPath) {
    const parentId = config.definitionBuildSettings[definitionId].parent;
    return parentId ? getTagsForVersion(parentId, version, registry, registryPath)[0] : null;
}

function getUpdatedTag(currentTag, currentRegistry, currentRegistryPath, updatedVersion, updatedRegistry, updatedRegistryPath) {
    updatedRegistry = updatedRegistry || currentRegistry;
    updatedRegistryPath = updatedRegistryPath || currentRegistryPath;
    const captureGroups = new RegExp(`${currentRegistry}/${currentRegistryPath}/(.+:.+)`).exec(currentTag);
    const updatedTags = getTagsForVersion(definitionTagLookup[`ANY/ANY/${captureGroups[1]}`], updatedVersion, updatedRegistry, updatedRegistryPath);
    if (updatedTags && updatedTags.length > 0) {
        console.log(`      Updating ${currentTag}\n      to ${updatedTags[0]}`);
        return updatedTags[0];
    }
    // In the case where this is already a tag with a version number in it,
    // we won't get an updated tag returned, so we'll just reuse the current tag.
    return currentTag;
}

// Return just the major version of a release number
function majorFromRelease(release) {
    const version = getVersionFromRelease(release);

    if (version === 'dev') {
        return 'dev';
    }

    const versionParts = version.split('.');
    return versionParts[0];
}

// Return an object from a map based on the linux distro for the definition
function objectByDefinitionLinuxDistro(definitionId, objectsByDistro) {
    const distro = getLinuxDistroForDefinition(definitionId);
    const obj = objectsByDistro[distro];
    return obj;
}

function getDefinitionDependencies(definitionId) {
    return config.definitionDependencies[definitionId];
}

function getAllDependencies() {
    return config.definitionDependencies;
}

async function getStagingFolder(release) {
    if (!stagingFolders[release]) {
        const stagingFolder = path.join(os.tmpdir(), 'vscode-dev-containers', release);
        console.log(`(*) Copying files to ${stagingFolder}\n`);
        await asyncUtils.rimraf(stagingFolder); // Clean out folder if it exists
        await asyncUtils.mkdirp(stagingFolder); // Create the folder
        await asyncUtils.copyFiles(
            path.resolve(__dirname, '..', '..', '..'),
            getConfig('filesToStage'),
            stagingFolder);

        stagingFolders[release] = stagingFolder;
    }
    return stagingFolders[release];
}

//TODO: Update references to getParentTagForVersion
//TODO: Update references to getTagsForVersion

module.exports = {
    loadConfig: loadConfig,
    getTagList: getTagList,
    getSortedDefinitionBuildList: getSortedDefinitionBuildList,
    getParentTagForVersion: getParentTagForVersion,
    getParentTagForDefinition: getParentTagForDefinition,
    getUpdatedTag: getUpdatedTag,
    majorFromRelease: majorFromRelease,
    objectByDefinitionLinuxDistro: objectByDefinitionLinuxDistro,
    getDefinitionDependencies: getDefinitionDependencies,
    getAllDependencies: getAllDependencies,
    getStagingFolder: getStagingFolder,
    getLinuxDistroForDefinition: getLinuxDistroForDefinition,
    getVersionFromRelease: getVersionFromRelease,
    getTagsForVersion: getTagsForVersion,
    getTagsForDefinition: getTagsForDefinition,
    getConfig: getConfig
};
