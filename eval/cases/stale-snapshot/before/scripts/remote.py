class Table:
    def __init__(self, name):
        self.name = name

    def create(self, row):
        raise NotImplementedError

    def delete(self, row_id):
        raise NotImplementedError
