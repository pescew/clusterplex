const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3500'

const TRANSCODER_PATH = process.env.TRANSCODER_PATH || '/usr/lib/plexmediaserver/'
const TRANSCODER_LOCAL_NAME = process.env.TRANSCODER_LOCAL_NAME || 'originalTranscoder'
const PMS_IP = process.env.PMS_IP || '127.0.0.1'
const TRANSCODER_VERBOSE = process.env.TRANSCODER_VERBOSE || '0'
// Operating mode:
// local
// remote
// both
const TRANSCODE_OPERATING_MODE = process.env.TRANSCODE_OPERATING_MODE || 'both'
const TRANSCODE_EAE_LOCALLY = process.env.TRANSCODE_EAE_LOCALLY || false

const { spawn } = require('child_process');
var ON_DEATH = require('death')({debug: true})

var jobPoster = require('./jobPoster')

if (TRANSCODE_OPERATING_MODE == 'local') {
    transcodeLocally(process.cwd(), process.argv.slice(2), process.env)
} else if (TRANSCODE_EAE_LOCALLY && process.argv.slice(2).filter(s => s.includes('eae_prefix')).length > 0) {
    console.log('EasyAudioEncoder used, forcing local transcode')
    transcodeLocally(process.cwd(), process.argv.slice(2), process.env)
} else {
    function setValueOf(arr, key, newValue) {
        let i = arr.indexOf(key)
        if (i > 0) {
            arr[i+1] = newValue
        }
    }

    let newArgs = process.argv.slice(2).map((v) => {
        return v.replace('127.0.0.1:', `${PMS_IP}:`)
    })

    if (TRANSCODER_VERBOSE == '1') {
        console.log('Setting VERBOSE to ON')
        setValueOf(newArgs, '-loglevel', 'verbose')
        setValueOf(newArgs, '-loglevel_plex', 'verbose')
    }

    let environmentVariables = process.env
    let workDir = process.cwd()

    getMediaInfo(extractFilePath(process.argv.slice(2))).then(function (mediaInfo) {
        console.log(`Sending request to orchestrator on: ${ORCHESTRATOR_URL}`)
        if (TRANSCODER_VERBOSE == '1') {
            console.log(`cwd => ${JSON.stringify(workDir)}`)
            console.log(`args => ${JSON.stringify(newArgs)}`)
            console.log(`env => ${JSON.stringify(environmentVariables)}`)
            console.log(`mediaInfo => ${JSON.stringify(mediaInfo)}`)
        }

        jobPoster.postJob(ORCHESTRATOR_URL,
            {
                type: 'transcode',
                payload: {
                    cwd: workDir,
                    args: newArgs,
                    env: environmentVariables,
                    mediaInfo: mediaInfo,
                }
            },
            (response) => {
                if (!response.result) {
                    console.error('Distributed transcoder failed, calling local')
                    if (TRANSCODE_OPERATING_MODE == 'both') {
                        transcodeLocally(process.cwd(), process.argv.slice(2), process.env);
                    } else {
                        // remote only
                        console.error(`Error transcoding and local transcode is disabled: TRANSCODE_OPERATING_MODE=${TRANSCODE_OPERATING_MODE}`)
                        process.exit(1)
                    }
                } else {
                    console.log("Remote Transcoding was successful")
                    process.exit(0)
                }
            }
        )
    });
}

function transcodeLocally(cwd, args, env) {
    let child = spawn(TRANSCODER_PATH + TRANSCODER_LOCAL_NAME, args, {
        cwd: cwd,
        env: env
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    withErrors = 0;
    child.on('error', (err) => {
        console.error(err);
        withErrors = 1;
    });
    child.on('close', (code) => {
        console.log('Completed local transcode');
        process.exit(withErrors);
    });
}

function getMediaInfo(filePath) {
    return new Promise(function (resolve, reject) {
        let child = spawn(TRANSCODER_PATH + TRANSCODER_LOCAL_NAME, ['-hide_banner', '-i', filePath]);
        let stderrData = []
        child.stderr.on('data', (data) => {
            stderrData = stderrData.concat(data);
        });
        child.stderr.on('end', () => {
            let output = Buffer.concat(stderrData).toString();
            let mediaInfo = {
                'audioCodec': '',
                'videoCodec': '',
                'videoHeight': 0,
                'videoWidth': 0,
            }
            let streams = ['Stream #0:0', 'Stream #0:1']
            for (const stream of streams) {
                let matchedStream = output.match(stream + '(.*), ')
                if (matchedStream) {
                    if (matchedStream[0].includes(" Video: ")) {
                        let extractedPortion = matchedStream[0].match(' Video: [^,]+?(?: |,)')
                        if (extractedPortion) {
                            let extractedVideoCodec = extractedPortion[0].replace('Video: ', '').replace(',', '').trim()
                            mediaInfo.videoCodec = extractedVideoCodec
                        }
                        let streamRes = matchedStream[0].match('(([\\d]{2,5}[x][\\d]{2,5}))')
                        if (streamRes) {
                            mediaInfo.videoWidth = parseInt(streamRes[0].split('x')[0], 10) || 0
                            mediaInfo.videoHeight = parseInt(streamRes[0].split('x')[1], 10) || 0
                        }
                    } else if (matchedStream[0].includes(' Audio: ')) {
                        let extractedPortion = matchedStream[0].match(' Audio: [^,]+?(?: |,)')
                        if (extractedPortion) {
                            let extractedAudioCodec = extractedPortion[0].replace('Audio: ', '').replace(',', '').trim()
                            mediaInfo.audioCodec = extractedAudioCodec
                        }
                    }
                }
            }
            resolve(mediaInfo)
        });
    });
}

function extractFilePath(argList) {
    let indexFilePath = argList.findIndex(s => s == '-i') + 1
    return (indexFilePath > 0 && argList) ? argList[indexFilePath] : ''
}

ON_DEATH( (signal, err) => {
    console.log('ON_DEATH signal detected')
    console.error(err)
    process.exit(signal)
})
