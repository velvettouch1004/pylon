import {build} from '@cronitio/pylon-builder'

import {sfiBuildPath, sfiSourcePath} from '../constants.js'

export default async (options: {}) => {
  await build({
    sfiFilePath: sfiSourcePath,
    outputFilePath: sfiBuildPath
  })
}
