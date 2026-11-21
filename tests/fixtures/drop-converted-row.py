"""Controlled physical conversion loss. Original PDF and prior workbook remain immutable."""
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
wb.worksheets[-1].delete_rows(2, 1)
wb.save(sys.argv[2])
