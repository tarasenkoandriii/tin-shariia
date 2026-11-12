const reportName = 'audit.txt';
const graph =
  '[0:a]ebur128=metadata=1:peak=true,silencedetect=noise=-45dB:d=0.5,ametadata=mode=print:file={{audit.txt}}[audit]';

export function createAudioAuditJob(sourceUrl) {
  const source = new URL(sourceUrl);
  if (source.protocol !== 'https:' || source.username || source.password || source.hash) {
    throw new Error('INVALID_AUDIT_SOURCE');
  }
  return {
    input_files: { src: source.href },
    output_files: [reportName],
    ffmpeg_commands: [
      `-i {{src}} -filter_complex "${graph}" -map "[audit]" -f null -`,
    ],
  };
}
