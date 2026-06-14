class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const sendControllerError = (res, error, fallbackMessage) => {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }

  console.error(`${fallbackMessage}:`, error);
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: error?.message || String(error),
  });
};

module.exports = {
  HttpError,
  sendControllerError,
};
