-- CATCHALL-SOURCE-OWNS-1014 (owner 2026-10-14): which emails a source keeps is the SOURCE pipe's own strategy (the
-- acceptedEmails its own workflow states), never read off the pipes it feeds. 0081's table recorded those pipes' words.
DROP TABLE IF EXISTS source_email_demands;
