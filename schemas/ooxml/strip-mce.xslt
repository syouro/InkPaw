<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"
  xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing">
  <xsl:template match="@*|node()">
    <xsl:copy><xsl:apply-templates select="@*|node()"/></xsl:copy>
  </xsl:template>
  <xsl:template match="@mc:*"/>
  <xsl:template match="mc:AlternateContent">
    <xsl:apply-templates select="mc:Choice[1]/node()"/>
  </xsl:template>
  <xsl:template match="w14:* | w15:* | w16:* | w16se:* | w16cid:* | w16cex:* | w16sdtdh:* | wp14:*"/>
  <xsl:template match="@w14:* | @w15:* | @w16:* | @w16se:* | @w16cid:* | @w16cex:* | @w16sdtdh:* | @wp14:*"/>
</xsl:stylesheet>
