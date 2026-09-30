class ExError(Exception):
    def __init__(self, message: str, detail: object = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail
