function cancelRecorderSession({ cancelledRef, generationRef }) {
  cancelledRef.current = true;
  generationRef.current += 1;
}

function isRecorderSessionCurrent({ generation, generationRef, cancelledRef }) {
  return !cancelledRef.current && generation === generationRef.current;
}

module.exports = {
  cancelRecorderSession,
  isRecorderSessionCurrent,
};
