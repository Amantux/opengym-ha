// Shared by client.mjs and screenshot.mjs for the big-upload checks.
// A well-formed but frameless MP4 of an exact size: ftyp (isom), one mdat of zeros, then a moov
// whose mvhd says 10 s. Enough for upstream's sniffMedia + mp4Info, which never decode frames.
export function syntheticMp4(totalBytes) {
  const box = (type, body) => {
    const b = Buffer.alloc(8 + body.length);
    b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8);
    return b;
  };
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'latin1'), Buffer.from([0, 0, 2, 0]), Buffer.from('isommp41', 'latin1')]));
  const mvhdBody = Buffer.alloc(100);           // version 0, flags 0, times 0
  mvhdBody.writeUInt32BE(1000, 12);             // timescale
  mvhdBody.writeUInt32BE(10_000, 16);           // duration: 10 s
  mvhdBody.writeUInt32BE(0x00010000, 20);       // rate 1.0
  mvhdBody.writeUInt16BE(0x0100, 24);           // volume 1.0
  mvhdBody.writeUInt32BE(0x00010000, 36);       // identity matrix: a, d, w
  mvhdBody.writeUInt32BE(0x00010000, 52);
  mvhdBody.writeUInt32BE(0x40000000, 68);
  mvhdBody.writeUInt32BE(2, 96);                // next_track_ID
  const moov = box('moov', box('mvhd', mvhdBody));
  const mdatLen = totalBytes - ftyp.length - moov.length;
  if (mdatLen < 8) throw new Error('too small');
  const mdatHead = Buffer.alloc(8); mdatHead.writeUInt32BE(mdatLen, 0); mdatHead.write('mdat', 4, 'latin1');
  return Buffer.concat([ftyp, mdatHead, Buffer.alloc(mdatLen - 8), moov]);
}
